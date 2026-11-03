//! Agent lending flows on Rhea/Burrow (spec §6.1, §6.2) and position reconciliation.
use std::collections::HashMap;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, NearToken, Promise, PromiseOrValue};

use crate::events::VaultEvent;
use crate::external::{
    self, burrow_positions, call, callback, ft_balance_of, gas, oracle_price, parse_positions, parse_price,
    result_json, result_u128, Positions, ONE_YOCTO,
};
use crate::math::{self, Leg, U256};
use crate::types::{OpKind, OpState, PendingDeleverage, Price, ReceiptStatus};
use crate::{Vault, VaultExt, MIN_SYNC_DELAY_NS, SYNC_FINAL_NS};

const MSG_INCREASE_COLLATERAL: &str = "\"OnlyIncreaseCollateral\"";
const MSG_REPAY: &str = "\"OnlyRepay\"";

/// Static gas for the borrow / withdraw precheck callback (it fires `execute_with_pyth`).
const GAS_CB_PRECHECK: near_sdk::Gas = near_sdk::Gas::from_tgas(200);
/// Repay precheck callback: fires `ft_transfer_call` + its settle callback.
const GAS_CB_REPAY: near_sdk::Gas = near_sdk::Gas::from_tgas(15 + 80 + 20);

#[near]
impl Vault {
    /// Wrap NEAR into wNEAR (stays in the vault). Keeps `min_near_reserve` and counts against the
    /// wNEAR caps (NEAR becomes a token the agent can move).
    pub fn agent_wrap_near(&mut self, amount: U128, reason_hash: String) -> Promise {
        self.assert_agent_action(&reason_hash);
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        self.assert_near_spendable(amount.0);
        let wrap = self.protocols.wrap.clone();
        self.assert_allowed_token(&wrap);
        let day = self.reserve_outflow(&wrap, amount.0);
        let op_id = self.begin_op(OpKind::WrapNear, Some(wrap.clone()), amount.0, Some(wrap.clone()), amount.0, day, reason_hash);
        self.assert_near_spendable(amount.0);
        self.mark_funds_sent(op_id);
        call(&wrap, "near_deposit", json!({}), NearToken::from_yoctonear(amount.0), gas::WRAP)
            .then(callback("on_simple_done", json!({ "op_id": op_id, "amount": amount }), gas::CB_SETTLE))
    }

    /// Supply `amount` of `token` to Burrow as collateral. Counts against the token's caps.
    pub fn agent_supply(&mut self, token: AccountId, amount: U128, reason_hash: String) -> Promise {
        self.assert_agent_action(&reason_hash);
        require!(self.policy.burrow_enabled, "ERR_BURROW_DISABLED");
        self.assert_allowed_token(&token);
        if let Some(d) = &self.deleverage {
            // during a deleverage cycle only the withdrawn collateral may go back in
            require!(d.collateral_token == token, "ERR_DELEVERAGE_PENDING");
        }
        let day = self.reserve_outflow(&token, amount.0);
        let op_id = self.begin_op(OpKind::Supply, Some(token.clone()), amount.0, None, amount.0, day, reason_hash);
        self.mark_funds_sent(op_id);
        self.ft_transfer_call_to(&token, &self.protocols.burrow.clone(), amount, MSG_INCREASE_COLLATERAL)
            .then(callback("on_transfer_call_done", json!({ "op_id": op_id, "debt_units": null }), gas::CB_SETTLE))
    }

    /// Repay Burrow debt. Not capped (it reduces risk), but the vault reads the debt first and sends
    /// at most debt + 1 unit, so nothing extra ends up as Burrow "supplied" outside the caps.
    pub fn agent_repay(&mut self, token: AccountId, amount: U128, reason_hash: String) -> Promise {
        self.assert_agent_action(&reason_hash);
        require!(self.policy.burrow_enabled, "ERR_BURROW_DISABLED");
        self.assert_allowed_token(&token);
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let op_id = self.begin_op(OpKind::Repay, Some(token.clone()), amount.0, None, 0, 0, reason_hash);
        burrow_positions(&self.protocols.burrow, &env::current_account_id())
            .then(callback("on_repay_precheck", json!({ "op_id": op_id }), GAS_CB_REPAY))
    }

    /// Borrow `amount` (token base units) and withdraw it to the vault. The vault first computes the
    /// projected health factor from Burrow positions + oracle prices and rejects it below the policy minimum.
    pub fn agent_borrow(&mut self, token: AccountId, amount: U128, reason_hash: String) -> Promise {
        self.assert_agent_action(&reason_hash);
        require!(self.policy.burrow_enabled, "ERR_BURROW_DISABLED");
        self.assert_allowed_token(&token);
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        self.assert_no_deleverage_pending();
        let op_id = self.begin_op(OpKind::Borrow, None, 0, Some(token.clone()), 0, 0, reason_hash);
        self.precheck(op_id, &token, amount, false)
    }

    /// Decrease collateral and withdraw it to the vault. With `deleverage = true` (allowed only while
    /// the health factor is below `deleverage_trigger_bps`) the HF may drop to `emergency_floor_bps`.
    pub fn agent_withdraw_collateral(
        &mut self,
        token: AccountId,
        amount: U128,
        deleverage: bool,
        reason_hash: String,
    ) -> Promise {
        self.assert_agent_action(&reason_hash);
        require!(self.policy.burrow_enabled, "ERR_BURROW_DISABLED");
        self.assert_allowed_token(&token);
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        // one deleverage cycle at a time: finish swap + repay before withdrawing more
        self.assert_no_deleverage_pending();
        let op_id = self.begin_op(OpKind::WithdrawCollateral, None, 0, Some(token.clone()), 0, 0, reason_hash);
        if let Some(o) = self.op_mut(op_id) {
            o.deleverage = deleverage;
        }
        self.precheck(op_id, &token, amount, deleverage)
    }

    /// Withdraw plain "supplied" balance (e.g. repay overpayment, or a borrow whose transfer failed)
    /// back into the vault. Funds only move into the vault.
    pub fn agent_withdraw_supplied(&mut self, token: AccountId, reason_hash: String) -> Promise {
        self.assert_agent_action(&reason_hash);
        require!(self.policy.burrow_enabled, "ERR_BURROW_DISABLED");
        self.assert_allowed_token(&token);
        let op_id = self.begin_op(OpKind::WithdrawSupplied, None, 0, Some(token.clone()), 0, 0, reason_hash);
        let me = env::current_account_id();
        ft_balance_of(&token, &me).then(callback(
            "on_snapshot_then_withdraw_supplied",
            json!({ "op_id": op_id, "token": token }),
            gas::BURROW_EXECUTE.saturating_add(gas::CB_SETTLE).saturating_add(gas::VIEW),
        ))
    }

    /// Reconciles a submitted op (borrow / withdraw) from real Burrow positions and vault balances,
    /// and refreshes the cached health factor. Callable by the agent or the owner, also while paused.
    pub fn sync_position(&mut self) -> Promise {
        self.assert_agent_or_owner();
        if self.in_flight.as_ref().map(|o| o.kind) == Some(OpKind::IntentsRoute) {
            return self.sync_intents();
        }
        let op = self.in_flight.clone();
        if let Some(op) = &op {
            require!(op.state == OpState::Submitted, "ERR_OP_NOT_SUBMITTED");
            let since = op.submitted_at.map(|t| t.0).unwrap_or(0);
            require!(env::block_timestamp() >= since + MIN_SYNC_DELAY_NS, "ERR_SYNC_TOO_EARLY");
        }
        let me = env::current_account_id();
        let tokens: Vec<AccountId> = self.tokens.keys().cloned().collect();
        let mut calls = vec![burrow_positions(&self.protocols.burrow, &me)];
        let watch = op.as_ref().and_then(|o| o.token_out.clone());
        if let Some(t) = &watch {
            calls.push(ft_balance_of(t, &me));
        }
        for t in &tokens {
            let info = self.tokens.get(t).unwrap();
            calls.push(oracle_price(&self.protocols.oracle, &info.price_id, self.policy.max_price_age_sec));
        }
        external::join(calls).then(callback(
            "on_sync",
            json!({ "op_id": op.map(|o| o.op_id), "has_balance": watch.is_some(), "tokens": tokens }),
            gas::CB_SETTLE,
        ))
    }

    // ---------------- callbacks ----------------

    /// Settles a simple call whose only result is success/failure (wrap).
    #[private]
    pub fn on_simple_done(&mut self, op_id: u64, amount: U128) {
        let Some(op) = self.op(op_id) else { return };
        if external::result_bytes(0).is_some() {
            self.finish_op(op_id, ReceiptStatus::Settled, amount.0, 0, None, "");
        } else {
            // the attached NEAR came back: nothing was spent
            self.finish_op(op_id, ReceiptStatus::Failed, 0, op.reserved.0, None, "external_failed");
        }
    }

    /// Settles an `ft_transfer_call` (supply / repay): the token returns the amount actually used.
    /// `debt_units` is the debt the repay precheck saw (repay only).
    #[private]
    pub fn on_transfer_call_done(&mut self, op_id: u64, debt_units: Option<U128>) {
        let Some(op) = self.op(op_id) else { return };
        let used = result_u128(0).unwrap_or(0).min(op.amount_in.0);
        let unused = op.amount_in.0 - used;
        if used == 0 {
            self.finish_op(op_id, ReceiptStatus::Failed, 0, op.reserved.0, None, "not_accepted");
            return;
        }
        let token = op.token_in.clone().unwrap();
        match op.kind {
            OpKind::Supply => self.deleverage_collateral_used(&token, used),
            OpKind::Repay => {
                let full = debt_units.is_some_and(|d| used >= d.0.saturating_sub(1));
                self.deleverage_repaid(&token, used, full);
            }
            _ => {}
        }
        let note = if unused > 0 { "partially_refunded" } else { "" };
        self.finish_op(op_id, ReceiptStatus::Settled, used, unused, None, note);
    }

    /// Result 0 = positions. Sends min(requested, debt + 1 unit).
    #[private]
    pub fn on_repay_precheck(&mut self, op_id: u64) -> PromiseOrValue<bool> {
        let Some(op) = self.op(op_id) else { return PromiseOrValue::Value(false) };
        let fail = |v: &mut Vault, note: &str| {
            v.finish_op(op_id, ReceiptStatus::Failed, 0, 0, None, note);
            PromiseOrValue::Value(false)
        };
        let token = op.token_in.clone().unwrap();
        let Some(pos) = result_json(0).as_ref().and_then(parse_positions) else { return fail(self, "positions_unreadable") };
        let Some(info) = self.tokens.get(&token).cloned() else { return fail(self, "token_not_registered") };
        let debt_inner = Positions::find(&pos.borrowed, &token).map(|e| e.balance).unwrap_or(0);
        if debt_inner == 0 {
            // nothing owed in this token: a pending deleverage has nothing left to repay
            self.deleverage_repaid(&token, 0, true);
            return fail(self, "no_debt");
        }
        // base units, rounded up, + 1 for interest accrued until the repay lands
        let scale = 10u128.pow(info.burrow_extra_decimals as u32);
        let debt_units = debt_inner.div_ceil(scale).saturating_add(1);
        let send = op.amount_in.0.min(debt_units);
        if let Some(o) = self.op_mut(op_id) {
            o.amount_in = U128(send);
        }
        self.mark_funds_sent(op_id);
        PromiseOrValue::Promise(
            self.ft_transfer_call_to(&token, &self.protocols.burrow.clone(), U128(send), MSG_REPAY)
                .then(callback("on_transfer_call_done", json!({ "op_id": op_id, "debt_units": U128(debt_units) }), gas::CB_SETTLE)),
        )
    }

    /// Results: 0 = positions, 1 = vault balance of `token`, 2 = Burrow assets, 3.. = prices of `price_tokens`.
    #[private]
    pub fn on_borrow_precheck(
        &mut self,
        op_id: u64,
        token: AccountId,
        amount: U128,
        deleverage: bool,
        price_tokens: Vec<AccountId>,
    ) -> PromiseOrValue<bool> {
        let Some(op) = self.op(op_id) else { return PromiseOrValue::Value(false) };
        let fail = |v: &mut Vault, note: &str| {
            v.finish_op(op_id, ReceiptStatus::Failed, 0, 0, None, note);
            PromiseOrValue::Value(false)
        };
        let Some(pos) = result_json(0).as_ref().and_then(parse_positions) else { return fail(self, "positions_unreadable") };
        let Some(balance_before) = result_u128(1) else { return fail(self, "balance_unreadable") };
        // Burrow's current risk settings (governance can change them after registration)
        match result_json(2) {
            Some(assets) => {
                if let Err(e) = self.refresh_token_configs(&assets) {
                    return fail(self, e);
                }
            }
            None => return fail(self, "assets_unreadable"),
        }
        let prices = match self.read_prices(3, &price_tokens) {
            Ok(p) => p,
            Err(e) => return fail(self, e),
        };
        let Some(info) = self.tokens.get(&token).cloned() else { return fail(self, "token_not_registered") };
        let inner = amount.0.checked_mul(10u128.pow(info.burrow_extra_decimals as u32));
        let Some(inner) = inner else { return fail(self, "amount_overflow") };

        let (current_hf, _, _) = match self.health(&pos, &prices, None) {
            Ok(h) => h,
            Err(e) => return fail(self, e),
        };
        let is_borrow = op.kind == OpKind::Borrow;
        let adjust = if is_borrow { Adjust::AddDebt(token.clone(), inner) } else { Adjust::RemoveCollateral(token.clone(), inner) };
        let (projected, _, _) = match self.health(&pos, &prices, Some(adjust)) {
            Ok(h) => h,
            Err(e) => return fail(self, e),
        };
        let floor = if !is_borrow && deleverage {
            if current_hf >= self.policy.deleverage_trigger_bps as u64 {
                return self.violation(op_id, "deleverage_not_needed", current_hf as u128, self.policy.deleverage_trigger_bps as u128, Some(current_hf));
            }
            self.policy.emergency_floor_bps
        } else {
            self.policy.min_health_factor_bps
        };
        if projected < floor as u64 {
            return self.violation(op_id, "min_health_factor", projected as u128, floor as u128, Some(projected));
        }

        let shares_before = if is_borrow {
            Positions::find(&pos.borrowed, &token).map(|e| e.shares).unwrap_or(0)
        } else {
            Positions::find(&pos.collateral, &token).map(|e| e.shares).unwrap_or(0)
        };
        if let Some(o) = self.op_mut(op_id) {
            o.balance_before = Some(U128(balance_before));
            o.shares_before = Some(U128(shares_before));
            o.amount_in = amount;
        }
        let first = if is_borrow {
            json!({ "Borrow": { "token_id": token, "amount": U128(inner) } })
        } else {
            json!({ "DecreaseCollateral": { "token_id": token, "amount": U128(inner) } })
        };
        // Withdraw with max_amount (never an exact amount): Burrow may credit 1 inner unit short.
        let actions = json!([first, { "Withdraw": { "token_id": token, "max_amount": U128(inner) } }]);
        PromiseOrValue::Promise(
            call(&self.protocols.burrow, "execute_with_pyth", json!({ "actions": actions }), ONE_YOCTO, gas::BURROW_EXECUTE_WITH_PYTH)
                .then(callback("on_execute_submitted", json!({ "op_id": op_id }), gas::CB_SETTLE)),
        )
    }

    /// `execute_with_pyth` doesn't return its inner promise, so success here only means "submitted".
    #[private]
    pub fn on_execute_submitted(&mut self, op_id: u64) {
        if external::result_bytes(0).is_some() {
            self.mark_submitted(op_id, "await_sync");
        } else {
            self.finish_op(op_id, ReceiptStatus::Failed, 0, 0, None, "execute_failed");
        }
    }

    #[private]
    pub fn on_snapshot_then_withdraw_supplied(&mut self, op_id: u64, token: AccountId) -> PromiseOrValue<bool> {
        let Some(balance) = result_u128(0) else {
            self.finish_op(op_id, ReceiptStatus::Failed, 0, 0, None, "balance_unreadable");
            return PromiseOrValue::Value(false);
        };
        if let Some(o) = self.op_mut(op_id) {
            o.balance_before = Some(U128(balance));
        }
        let actions = json!([{ "Withdraw": { "token_id": token } }]);
        PromiseOrValue::Promise(
            call(&self.protocols.burrow, "execute", json!({ "actions": actions }), ONE_YOCTO, gas::BURROW_EXECUTE)
                .then(callback("on_execute_submitted", json!({ "op_id": op_id }), gas::CB_SETTLE)),
        )
    }

    /// Results: 0 = positions, [1 = vault balance of op token if `has_balance`], then prices of `tokens`.
    #[private]
    pub fn on_sync(&mut self, op_id: Option<near_sdk::json_types::U64>, has_balance: bool, tokens: Vec<AccountId>) {
        let pos = result_json(0).as_ref().and_then(parse_positions);
        let balance = if has_balance { result_u128(1) } else { None };
        let price_start = if has_balance { 2 } else { 1 };
        let health = match (&pos, self.read_prices(price_start, &tokens)) {
            (Some(p), Ok(prices)) => self.health(p, &prices, None).ok(),
            _ => None,
        };
        if let Some((hf, coll, debt)) = health {
            self.record_health(hf, coll, debt);
        }
        let hf = health.map(|h| h.0);

        let Some(op_id) = op_id.map(|o| o.0) else { return };
        let Some(op) = self.op(op_id) else { return };
        let (Some(pos), Some(after)) = (pos, balance) else {
            // Can't read state now: keep the op so sync can be retried (or the owner clears it).
            env::log_str("sync: state unreadable, retry later");
            return;
        };
        let token = op.token_out.clone().unwrap();
        let before = op.balance_before.map(|b| b.0).unwrap_or(0);
        let received = after.saturating_sub(before);
        let shares_before = op.shares_before.map(|s| s.0).unwrap_or(0);
        // "No effect yet" only becomes "not executed" after SYNC_FINAL_NS: Burrow's detached receipts
        // may still land, and releasing the lock early would let the agent stack another borrow.
        let submitted = op.submitted_at.map(|t| t.0).unwrap_or(op.started_at.0);
        let is_final = env::block_timestamp() >= submitted.saturating_add(SYNC_FINAL_NS);
        match op.kind {
            OpKind::Borrow => {
                let shares_now = Positions::find(&pos.borrowed, &token).map(|e| e.shares).unwrap_or(0);
                if shares_now > shares_before {
                    let note = if received == 0 { "borrowed_funds_in_burrow_supplied" } else { "" };
                    self.finish_op(op_id, ReceiptStatus::Settled, received, 0, hf, note);
                } else if is_final {
                    self.finish_op(op_id, ReceiptStatus::Failed, 0, 0, hf, "borrow_not_executed");
                } else {
                    env::log_str("sync: borrow not visible yet, still pending");
                }
            }
            OpKind::WithdrawCollateral => {
                let shares_now = Positions::find(&pos.collateral, &token).map(|e| e.shares).unwrap_or(0);
                if shares_now < shares_before {
                    let note = if received == 0 { "withdrawn_funds_in_burrow_supplied" } else { "" };
                    if op.deleverage {
                        // what still has to be swapped and repaid (if the funds landed as Burrow
                        // "supplied", the agent first pulls them back with agent_withdraw_supplied)
                        let left = if received > 0 { received } else { op.amount_in.0 };
                        self.deleverage = Some(PendingDeleverage {
                            collateral_token: token.clone(),
                            collateral_left: U128(left),
                            debt_token: None,
                            repay_due: U128(0),
                            started_at: U64(env::block_timestamp()),
                        });
                    }
                    self.finish_op(op_id, ReceiptStatus::Settled, received, 0, hf, note);
                } else if is_final {
                    self.finish_op(op_id, ReceiptStatus::Failed, 0, 0, hf, "withdraw_not_executed");
                } else {
                    env::log_str("sync: withdraw not visible yet, still pending");
                }
            }
            OpKind::WithdrawSupplied => {
                if received > 0 {
                    self.finish_op(op_id, ReceiptStatus::Settled, received, 0, hf, "");
                } else if is_final {
                    self.finish_op(op_id, ReceiptStatus::Failed, 0, 0, hf, "nothing_withdrawn");
                } else {
                    env::log_str("sync: withdrawal not visible yet, still pending");
                }
            }
            _ => {
                // Other kinds settle in their own callbacks; sync only refreshed health.
            }
        }
    }
}

pub(crate) enum Adjust {
    AddDebt(AccountId, u128),
    RemoveCollateral(AccountId, u128),
}

impl Vault {
    /// Updates cached `volatility_ratio_bps` / `burrow_extra_decimals` from a Burrow `get_assets`
    /// response. Tokens missing from the response keep their cached values.
    pub(crate) fn refresh_token_configs(&mut self, assets: &Value) -> Result<(), &'static str> {
        let list = assets.as_array().ok_or("assets_unreadable")?;
        for a in list {
            let Some(id) = a.get("token_id").and_then(Value::as_str).and_then(|s| s.parse::<AccountId>().ok()) else { continue };
            let Some(mut info) = self.tokens.get(&id).cloned() else { continue };
            let cfg = a.get("config").ok_or("assets_unreadable")?;
            let vol = cfg.get("volatility_ratio").and_then(Value::as_u64).ok_or("assets_unreadable")?;
            let extra = cfg.get("extra_decimals").and_then(Value::as_u64).ok_or("assets_unreadable")?;
            if vol == 0 || vol > 10_000 || extra > 30 {
                return Err("asset_config_invalid");
            }
            if info.volatility_ratio_bps != vol as u32 || info.burrow_extra_decimals != extra as u8 {
                env::log_str(&format!("token config refreshed: {id} volatility {} -> {vol}", info.volatility_ratio_bps));
                info.volatility_ratio_bps = vol as u32;
                info.burrow_extra_decimals = extra as u8;
                self.tokens.insert(id, info);
            }
        }
        Ok(())
    }

    /// Withdrawn collateral went back in (supply) or was swapped away.
    pub(crate) fn deleverage_collateral_used(&mut self, token: &AccountId, amount: u128) {
        if let Some(d) = self.deleverage.as_mut() {
            if &d.collateral_token == token {
                d.collateral_left = U128(d.collateral_left.0.saturating_sub(amount));
            }
        }
        self.maybe_finish_deleverage();
    }

    /// The withdrawn collateral was swapped: the proceeds must now be repaid.
    pub(crate) fn deleverage_swapped(&mut self, token_in: &AccountId, amount_in: u128, token_out: &AccountId, amount_out: u128) {
        if let Some(d) = self.deleverage.as_mut() {
            if &d.collateral_token == token_in {
                d.collateral_left = U128(d.collateral_left.0.saturating_sub(amount_in));
                d.debt_token = Some(token_out.clone());
                d.repay_due = U128(d.repay_due.0.saturating_add(amount_out));
            }
        }
        self.maybe_finish_deleverage();
    }

    /// A repay settled (`full` = the whole debt in `token` is now repaid).
    pub(crate) fn deleverage_repaid(&mut self, token: &AccountId, amount: u128, full: bool) {
        if let Some(d) = self.deleverage.as_mut() {
            if d.debt_token.as_ref() == Some(token) {
                d.repay_due = U128(if full { 0 } else { d.repay_due.0.saturating_sub(amount) });
            }
        }
        self.maybe_finish_deleverage();
    }

    pub(crate) fn ft_transfer_call_to(&self, token: &AccountId, receiver: &AccountId, amount: U128, msg: &str) -> Promise {
        call(
            token,
            "ft_transfer_call",
            json!({ "receiver_id": receiver, "amount": amount, "msg": msg }),
            ONE_YOCTO,
            gas::FT_TRANSFER_CALL,
        )
    }

    /// Reads positions, the vault balance of `token`, Burrow's asset configs and prices of every
    /// registered token, then runs `on_borrow_precheck`.
    fn precheck(&mut self, op_id: u64, token: &AccountId, amount: U128, deleverage: bool) -> Promise {
        let me = env::current_account_id();
        let price_tokens: Vec<AccountId> = self.tokens.keys().cloned().collect();
        let mut calls = vec![
            burrow_positions(&self.protocols.burrow, &me),
            ft_balance_of(token, &me),
            call(&self.protocols.burrow, "get_assets", json!({ "token_ids": price_tokens }), external::NO_DEPOSIT, gas::VIEW),
        ];
        for t in &price_tokens {
            let info = self.tokens.get(t).unwrap();
            calls.push(oracle_price(&self.protocols.oracle, &info.price_id, self.policy.max_price_age_sec));
        }
        external::join(calls).then(callback(
            "on_borrow_precheck",
            json!({ "op_id": op_id, "token": token, "amount": amount, "deleverage": deleverage, "price_tokens": price_tokens }),
            GAS_CB_PRECHECK,
        ))
    }

    /// Reads and validates prices for `tokens` from promise results starting at `start`.
    pub(crate) fn read_prices(&self, start: u64, tokens: &[AccountId]) -> Result<HashMap<AccountId, Price>, &'static str> {
        let now = (env::block_timestamp() / 1_000_000_000) as i64;
        let mut out = HashMap::new();
        for (i, t) in tokens.iter().enumerate() {
            let p = result_json(start + i as u64).as_ref().and_then(parse_price).ok_or("price_missing")?;
            math::check_price(&p, now, self.policy.max_price_age_sec, self.policy.max_price_conf_bps)?;
            out.insert(t.clone(), p);
        }
        Ok(out)
    }

    /// Health factor of the vault's Burrow position, optionally with a hypothetical change.
    pub(crate) fn health(
        &self,
        pos: &Positions,
        prices: &HashMap<AccountId, Price>,
        adjust: Option<Adjust>,
    ) -> Result<(u64, U256, U256), &'static str> {
        let mut coll: Vec<(AccountId, u128)> = vec![];
        let mut debt: Vec<(AccountId, u128)> = vec![];
        for e in &pos.collateral {
            coll.push((e.token_id.parse().map_err(|_| "bad_token_id")?, e.balance));
        }
        for e in &pos.borrowed {
            debt.push((e.token_id.parse().map_err(|_| "bad_token_id")?, e.balance));
        }
        match adjust {
            Some(Adjust::AddDebt(t, amt)) => match debt.iter_mut().find(|(id, _)| *id == t) {
                Some(d) => d.1 = d.1.checked_add(amt).ok_or("overflow")?,
                None => debt.push((t, amt)),
            },
            Some(Adjust::RemoveCollateral(t, amt)) => {
                let c = coll.iter_mut().find(|(id, _)| *id == t).ok_or("no_such_collateral")?;
                c.1 = c.1.checked_sub(amt).ok_or("not_enough_collateral")?;
            }
            None => {}
        }
        let leg = |(t, amt): &(AccountId, u128)| -> Result<Leg, &'static str> {
            let info = self.tokens.get(t).ok_or("unknown_position_token")?;
            let p = prices.get(t).ok_or("price_missing")?;
            Ok(Leg { value_usd: math::usd_value(*amt, info.inner_decimals(), p), volatility_ratio_bps: info.volatility_ratio_bps })
        };
        let c: Vec<Leg> = coll.iter().map(leg).collect::<Result<_, _>>()?;
        let d: Vec<Leg> = debt.iter().map(leg).collect::<Result<_, _>>()?;
        Ok(math::health_factor_bps(&c, &d))
    }

    /// Fail the op with a policy violation (emitted from a callback, so the event survives).
    pub(crate) fn violation(&mut self, op_id: u64, rule: &str, value: u128, limit: u128, hf: Option<u64>) -> PromiseOrValue<bool> {
        VaultEvent::PolicyViolation {
            op_id: Some(near_sdk::json_types::U64(op_id)),
            rule: rule.to_string(),
            value: value.to_string(),
            limit: limit.to_string(),
        }
        .emit();
        let release = self.op(op_id).map(|o| o.reserved.0).unwrap_or(0);
        self.finish_op(op_id, ReceiptStatus::Failed, 0, release, hf, rule);
        PromiseOrValue::Value(false)
    }
}

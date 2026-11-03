//! Agent swaps on Ref v2 (spec §6.3): deposit → swap → withdraw, so the output amount is known on-chain.
//! The vault checks the pool's token pair, computes `min_out` from oracle prices itself (never from the
//! agent), and only uses allowlisted single-hop pools (lesson from the April 2026 Rhea exploit).
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{near, require, AccountId, Gas, Promise, PromiseOrValue};

use crate::external::{self, call, callback, gas, oracle_price, result_json, result_u128, ONE_YOCTO};
use crate::math;
use crate::types::{OpKind, ReceiptStatus};
use crate::{Vault, VaultExt};

// Static gas per hop of the chain (each callback reserves what the rest of the chain needs).
const GAS_CB_WITHDRAWN: Gas = Gas::from_tgas(20);
const GAS_CB_SWAPPED: Gas = Gas::from_tgas(15 + 40 + 20);
const GAS_CB_DEPOSITED: Gas = Gas::from_tgas(15 + 30 + 75);
const GAS_CB_PRECHECK: Gas = Gas::from_tgas(15 + 80 + 120);

#[near]
impl Vault {
    pub fn agent_swap_ref(
        &mut self,
        pool_id: u64,
        token_in: AccountId,
        token_out: AccountId,
        amount_in: U128,
        reason_hash: String,
    ) -> Promise {
        self.assert_agent_action(&reason_hash);
        require!(self.policy.ref_enabled, "ERR_REF_DISABLED");
        require!(self.policy.allowed_ref_pools.contains(&pool_id), "ERR_POOL_NOT_ALLOWED");
        require!(token_in != token_out, "ERR_SAME_TOKEN");
        let info_in = self.assert_allowed_token(&token_in);
        let info_out = self.assert_allowed_token(&token_out);
        if let Some(d) = &self.deleverage {
            // during a deleverage cycle: only swap the withdrawn collateral, into one debt token
            require!(d.collateral_token == token_in, "ERR_DELEVERAGE_PENDING");
            require!(d.debt_token.as_ref().is_none_or(|t| *t == token_out), "ERR_DELEVERAGE_PENDING");
        }
        let day = self.reserve_outflow(&token_in, amount_in.0);
        let op_id = self.begin_op(
            OpKind::SwapRef,
            Some(token_in.clone()),
            amount_in.0,
            Some(token_out.clone()),
            amount_in.0,
            day,
            reason_hash,
        );
        if let Some(o) = self.op_mut(op_id) {
            o.pool_id = Some(pool_id);
        }
        let age = self.policy.max_price_age_sec;
        external::join(vec![
            oracle_price(&self.protocols.oracle, &info_in.price_id, age),
            oracle_price(&self.protocols.oracle, &info_out.price_id, age),
            call(&self.protocols.ref_exchange, "get_pool", json!({ "pool_id": pool_id }), external::NO_DEPOSIT, gas::VIEW),
        ])
        .then(callback("on_swap_precheck", json!({ "op_id": op_id }), GAS_CB_PRECHECK))
    }

    /// Withdraws the vault's whole Ref deposit of `token` back into the vault (recovery after a
    /// failed withdraw). Agent (when idle, not paused, Ref enabled) or owner. Funds only move into the vault.
    pub fn recover_ref(&mut self, token: AccountId) -> Promise {
        let is_owner = self.assert_agent_or_owner();
        if !is_owner {
            require!(!self.paused, "ERR_PAUSED");
            require!(self.policy.ref_enabled, "ERR_REF_DISABLED");
            require!(self.in_flight.is_none(), "ERR_OP_IN_FLIGHT");
        }
        // amount "0" = withdraw everything
        call(
            &self.protocols.ref_exchange,
            "withdraw",
            json!({ "token_id": token, "amount": "0", "skip_unwrap_near": true }),
            ONE_YOCTO,
            gas::REF_WITHDRAW,
        )
    }

    // ---------------- callbacks ----------------

    /// Results: 0 = price in, 1 = price out, 2 = pool info.
    #[private]
    pub fn on_swap_precheck(&mut self, op_id: u64) -> PromiseOrValue<bool> {
        let Some(op) = self.op(op_id) else { return PromiseOrValue::Value(false) };
        let token_in = op.token_in.clone().unwrap();
        let token_out = op.token_out.clone().unwrap();
        let fail = |v: &mut Vault, note: &str| {
            v.finish_op(op_id, ReceiptStatus::Failed, 0, op.reserved.0, None, note);
            PromiseOrValue::Value(false)
        };
        let prices = match self.read_prices(0, &[token_in.clone(), token_out.clone()]) {
            Ok(p) => p,
            Err(e) => return fail(self, e),
        };
        // The pool must be exactly the (token_in, token_out) pair.
        let pair_ok = result_json(2)
            .and_then(|pool| {
                let ids: Vec<String> = pool
                    .get("token_account_ids")?
                    .as_array()?
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                Some(ids.len() == 2 && ids.contains(&token_in.to_string()) && ids.contains(&token_out.to_string()))
            })
            .unwrap_or(false);
        if !pair_ok {
            return self.violation(op_id, "pool_token_pair", 0, 0, None);
        }
        let info_in = self.tokens.get(&token_in).cloned().unwrap();
        let info_out = self.tokens.get(&token_out).cloned().unwrap();
        let min_out = math::min_out(
            op.amount_in.0,
            info_in.decimals as u32,
            &prices[&token_in],
            info_out.decimals as u32,
            &prices[&token_out],
            self.policy.max_slippage_bps,
        );
        if min_out == 0 {
            return fail(self, "min_out_zero");
        }
        if let Some(o) = self.op_mut(op_id) {
            o.min_out = U128(min_out);
            o.funds_sent = true;
        }
        // Step 1: deposit token_in into the vault's Ref balance (msg "" = deposit only).
        PromiseOrValue::Promise(
            self.ft_transfer_call_to(&token_in, &self.protocols.ref_exchange.clone(), op.amount_in, "")
                .then(callback("on_ref_deposited", json!({ "op_id": op_id }), GAS_CB_DEPOSITED)),
        )
    }

    #[private]
    pub fn on_ref_deposited(&mut self, op_id: u64) -> PromiseOrValue<bool> {
        let Some(op) = self.op(op_id) else { return PromiseOrValue::Value(false) };
        let used = result_u128(0).unwrap_or(0);
        if used == 0 {
            // Nothing left the vault.
            self.finish_op(op_id, ReceiptStatus::Failed, 0, op.reserved.0, None, "ref_deposit_failed");
            return PromiseOrValue::Value(false);
        }
        let token_in = op.token_in.clone().unwrap();
        let token_out = op.token_out.clone().unwrap();
        if let Some(o) = self.op_mut(op_id) {
            o.amount_in = U128(used); // deposited amount is what we swap
        }
        // Step 2: swap inside Ref. Ref checks min_amount_out; returns amount_out credited to our Ref balance.
        let action = json!({
            "pool_id": op.pool_id.unwrap(),
            "token_in": token_in,
            "amount_in": U128(used),
            "token_out": token_out,
            "min_amount_out": op.min_out,
        });
        PromiseOrValue::Promise(
            call(&self.protocols.ref_exchange, "swap", json!({ "actions": [action] }), external::NO_DEPOSIT, gas::REF_SWAP)
                .then(callback("on_ref_swapped", json!({ "op_id": op_id }), GAS_CB_SWAPPED)),
        )
    }

    #[private]
    pub fn on_ref_swapped(&mut self, op_id: u64) -> PromiseOrValue<bool> {
        let Some(op) = self.op(op_id) else { return PromiseOrValue::Value(false) };
        let (token, amount, swapped) = match result_u128(0) {
            Some(out) if out >= op.min_out.0 => (op.token_out.clone().unwrap(), out, true),
            // Swap failed (e.g. slippage): take token_in back out of Ref.
            _ => (op.token_in.clone().unwrap(), op.amount_in.0, false),
        };
        // Step 3: withdraw to the vault. Ref returns the amount sent, or 0 if the transfer failed
        // (then the funds stay in our Ref balance; recover with `recover_ref`).
        PromiseOrValue::Promise(
            call(
                &self.protocols.ref_exchange,
                "withdraw",
                json!({ "token_id": token, "amount": U128(amount), "skip_unwrap_near": true }),
                ONE_YOCTO,
                gas::REF_WITHDRAW,
            )
            .then(callback(
                "on_ref_withdrawn",
                json!({ "op_id": op_id, "swapped": swapped, "amount": U128(amount) }),
                GAS_CB_WITHDRAWN,
            )),
        )
    }

    #[private]
    pub fn on_ref_withdrawn(&mut self, op_id: u64, swapped: bool, amount: U128) {
        let Some(op) = self.op(op_id) else { return };
        let withdrawn = result_u128(0).unwrap_or(0);
        if swapped {
            self.deleverage_swapped(op.token_in.as_ref().unwrap(), op.amount_in.0, op.token_out.as_ref().unwrap(), amount.0);
        }
        match (swapped, withdrawn > 0) {
            (true, true) => self.finish_op(op_id, ReceiptStatus::Settled, amount.0, 0, None, ""),
            (true, false) => self.finish_op(op_id, ReceiptStatus::Settled, amount.0, 0, None, "output_in_ref_deposit_call_recover_ref"),
            // Swap failed and token_in came back: nothing was spent, release the reservation.
            (false, true) => self.finish_op(op_id, ReceiptStatus::Failed, 0, op.reserved.0, None, "swap_failed_refunded"),
            (false, false) => self.finish_op(op_id, ReceiptStatus::Failed, 0, 0, None, "swap_failed_input_in_ref_deposit_call_recover_ref"),
        }
    }
}

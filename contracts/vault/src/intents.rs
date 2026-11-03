//! Agent routing through NEAR Intents / 1Click (spec §6.4).
//!
//! A 1Click deposit address is opaque, so the vault only funds a quote that is
//! (1) signed by 1Click (ed25519 over base58(sha256(canonical_json))), (2) unused before,
//! (3) delivers to and refunds to this vault inside Intents, (4) within caps, and
//! (5) priced close to the oracle: the signed `amountOut` within `max_intents_spread_bps` (this
//! bounds fees, including unsigned `appFees`) and `minAmountOut` within `max_slippage_bps`.
//! Signed fields the vault doesn't understand are rejected (they could redirect the output).
//! The vault never registers a public key on intents.near (keys there have unrestricted control).
use near_sdk::json_types::U128;
use near_sdk::serde::de::IgnoredAny;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, Promise, PromiseOrValue};

use crate::external::{self, call, callback, gas, oracle_price, result_u128, ONE_YOCTO};
use crate::math;
use crate::types::{OpKind, OpState, ReceiptStatus};
use crate::{Vault, VaultExt, MIN_SYNC_DELAY_NS};

/// Quotes older than this are rejected.
const MAX_QUOTE_AGE_NS: u64 = 5 * 60 * 1_000_000_000;
/// The deposit address must stay valid at least this long.
const MIN_DEADLINE_MARGIN_NS: u64 = 2 * 60 * 1_000_000_000;

const GAS_CB_FUNDED: Gas = Gas::from_tgas(20);
const GAS_CB_DEPOSITED: Gas = Gas::from_tgas(15 + 30 + 20);
const GAS_CB_PRECHECK: Gas = Gas::from_tgas(15 + 80 + 65);

/// Every field 1Click may sign (one-click-api.md §6). Unknown fields are rejected.
#[allow(dead_code)] // the informational fields exist only so deny_unknown_fields accepts them
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedQuote {
    pub dry: bool,
    pub swap_type: String,
    pub slippage_tolerance: u32,
    pub origin_asset: String,
    pub destination_asset: String,
    pub deposit_type: String,
    pub recipient: String,
    pub recipient_type: String,
    pub refund_to: String,
    pub refund_type: String,
    pub amount: String,
    pub amount_in: String,
    pub amount_out: String,
    pub min_amount_out: String,
    pub deposit_address: Option<String>,
    pub deadline: Option<String>,
    pub timestamp: String,
    // Informational, safe to ignore.
    pub amount_in_formatted: Option<IgnoredAny>,
    pub amount_in_usd: Option<IgnoredAny>,
    pub min_amount_in: Option<IgnoredAny>,
    pub amount_out_formatted: Option<IgnoredAny>,
    pub amount_out_usd: Option<IgnoredAny>,
    pub quote_waiting_time_ms: Option<IgnoredAny>,
    pub referral: Option<IgnoredAny>,
    pub time_when_inactive: Option<IgnoredAny>,
    pub time_estimate: Option<IgnoredAny>,
    pub refund_fee: Option<IgnoredAny>,
    pub withdraw_fee: Option<IgnoredAny>,
    // Could change where or how the output is delivered: must be absent.
    pub virtual_chain_recipient: Option<IgnoredAny>,
    pub virtual_chain_refund_recipient: Option<IgnoredAny>,
    pub custom_recipient_msg: Option<IgnoredAny>,
    pub deposit_memo: Option<IgnoredAny>,
}

#[near]
impl Vault {
    /// `signed_quote` is the exact canonical JSON string 1Click signed; `signature` is "ed25519:<base58>".
    pub fn agent_route_intents(&mut self, signed_quote: String, signature: String, reason_hash: String) -> Promise {
        self.assert_agent_action(&reason_hash);
        require!(self.policy.intents_enabled, "ERR_INTENTS_DISABLED");
        let pubkey = self.policy.intents_quote_pubkey.clone().unwrap_or_else(|| env::panic_str("ERR_NO_QUOTE_KEY"));
        require!(verify_quote_signature(&signed_quote, &signature, &pubkey), "ERR_BAD_QUOTE_SIGNATURE");

        let hash = env::sha256_array(signed_quote.as_bytes());
        require!(!self.used_quotes.contains(&hash), "ERR_QUOTE_REUSED");
        self.assert_no_deleverage_pending();

        let q: SignedQuote = serde_json::from_str(&signed_quote).unwrap_or_else(|_| env::panic_str("ERR_BAD_QUOTE_JSON"));
        let me = env::current_account_id();
        let deposit_address = check_vault_quote(&q, &me, env::block_timestamp())
            .unwrap_or_else(|e| env::panic_str(&format!("ERR_QUOTE: {e}")));
        require!(q.slippage_tolerance <= self.policy.max_slippage_bps as u32, "ERR_QUOTE_SLIPPAGE");
        let token_in = nep141_token(&q.origin_asset).unwrap_or_else(|| env::panic_str("ERR_ORIGIN_ASSET"));
        let token_out = nep141_token(&q.destination_asset).unwrap_or_else(|| env::panic_str("ERR_DESTINATION_ASSET"));
        require!(token_in != token_out, "ERR_SAME_TOKEN");
        let info_in = self.assert_allowed_token(&token_in);
        let info_out = self.assert_allowed_token(&token_out);
        let amount_in: u128 = q.amount_in.parse().unwrap_or_else(|_| env::panic_str("ERR_AMOUNT"));
        let amount_out: u128 = q.amount_out.parse().unwrap_or_else(|_| env::panic_str("ERR_AMOUNT_OUT"));
        let min_amount_out: u128 = q.min_amount_out.parse().unwrap_or_else(|_| env::panic_str("ERR_MIN_OUT"));
        require!(min_amount_out <= amount_out, "ERR_MIN_OUT");

        // The quote is marked used once it is funded (on_intents_funded); until then the lock
        // stops a second route, and an unfunded quote costs nothing to retry.
        let day = self.reserve_outflow(&token_in, amount_in);
        let op_id = self.begin_op(OpKind::IntentsRoute, Some(token_in.clone()), amount_in, Some(token_out.clone()), amount_in, day, reason_hash);
        if let Some(o) = self.op_mut(op_id) {
            o.min_out = U128(min_amount_out);
            o.deposit_address = Some(deposit_address.to_string());
            o.quote_hash = Some(hex(&hash));
        }
        let age = self.policy.max_price_age_sec;
        let intents = self.protocols.intents.clone();
        external::join(vec![
            oracle_price(&self.protocols.oracle, &info_in.price_id, age),
            oracle_price(&self.protocols.oracle, &info_out.price_id, age),
            mt_balance_of(&intents, &me, &token_out),
            mt_balance_of(&intents, &me, &token_in),
        ])
        .then(callback("on_intents_precheck", json!({ "op_id": op_id, "quoted_out": U128(amount_out) }), GAS_CB_PRECHECK))
    }

    /// Pull the vault's Intents balance of `token` back into the vault (inflow only, not capped).
    /// No `msg` → refunded inside Intents if the transfer fails.
    pub fn agent_intents_withdraw(&mut self, token: AccountId, amount: U128, reason_hash: String) -> Promise {
        self.assert_agent_action(&reason_hash);
        require!(self.policy.intents_enabled, "ERR_INTENTS_DISABLED");
        self.assert_allowed_token(&token);
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let op_id = self.begin_op(OpKind::IntentsWithdraw, None, 0, Some(token.clone()), 0, 0, reason_hash);
        call(
            &self.protocols.intents,
            "ft_withdraw",
            json!({ "token": token, "receiver_id": env::current_account_id(), "amount": amount }),
            ONE_YOCTO,
            gas::INTENTS_WITHDRAW,
        )
        .then(callback("on_intents_withdrawn", json!({ "op_id": op_id, "amount": amount }), external::gas::CB_SETTLE))
    }

    // ---------------- callbacks ----------------

    /// Results: 0 = price in, 1 = price out, 2 = Intents balance of token_out, 3 = Intents balance of token_in.
    #[private]
    pub fn on_intents_precheck(&mut self, op_id: u64, quoted_out: U128) -> PromiseOrValue<bool> {
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
        let (Some(out_before), Some(in_before)) = (result_u128(2), result_u128(3)) else {
            return fail(self, "intents_balance_unreadable");
        };
        let info_in = self.tokens.get(&token_in).cloned().unwrap();
        let info_out = self.tokens.get(&token_out).cloned().unwrap();
        let floor = math::min_out(
            op.amount_in.0,
            info_in.decimals as u32,
            &prices[&token_in],
            info_out.decimals as u32,
            &prices[&token_out],
            self.policy.max_slippage_bps,
        );
        if op.min_out.0 < floor {
            return self.violation(op_id, "quote_below_oracle", op.min_out.0, floor, None);
        }
        // Fees (1Click's and any unsigned appFees) come out of amountOut: keep it near the oracle price.
        let fair = math::min_out(
            op.amount_in.0,
            info_in.decimals as u32,
            &prices[&token_in],
            info_out.decimals as u32,
            &prices[&token_out],
            self.policy.max_intents_spread_bps,
        );
        if quoted_out.0 < fair {
            return self.violation(op_id, "quote_spread", quoted_out.0, fair, None);
        }
        if let Some(o) = self.op_mut(op_id) {
            o.balance_before = Some(U128(out_before));
            o.shares_before = Some(U128(in_before)); // reused slot: Intents balance of token_in before
            o.funds_sent = true;
        }
        // Step 1: move token_in into the vault's own Intents balance (msg "" credits the sender).
        PromiseOrValue::Promise(
            self.ft_transfer_call_to(&token_in, &self.protocols.intents.clone(), op.amount_in, "")
                .then(callback("on_intents_deposited", json!({ "op_id": op_id }), GAS_CB_DEPOSITED)),
        )
    }

    #[private]
    pub fn on_intents_deposited(&mut self, op_id: u64) -> PromiseOrValue<bool> {
        let Some(op) = self.op(op_id) else { return PromiseOrValue::Value(false) };
        let used = result_u128(0).unwrap_or(0);
        if used < op.amount_in.0 {
            let note = if used == 0 { "intents_deposit_failed" } else { "intents_deposit_partial_funds_in_intents_balance" };
            let release = if used == 0 { op.reserved.0 } else { 0 };
            self.finish_op(op_id, ReceiptStatus::Failed, 0, release, None, note);
            return PromiseOrValue::Value(false);
        }
        let token_in = op.token_in.clone().unwrap();
        // Step 2: fund the quote by transferring inside Intents to its deposit address.
        PromiseOrValue::Promise(
            call(
                &self.protocols.intents,
                "mt_transfer",
                json!({
                    "receiver_id": op.deposit_address.clone().unwrap(),
                    "token_id": format!("nep141:{token_in}"),
                    "amount": op.amount_in,
                }),
                ONE_YOCTO,
                gas::INTENTS_CALL,
            )
            .then(callback("on_intents_funded", json!({ "op_id": op_id }), GAS_CB_FUNDED)),
        )
    }

    #[private]
    pub fn on_intents_funded(&mut self, op_id: u64) {
        if external::result_bytes(0).is_some() {
            if let Some(h) = self.op(op_id).and_then(|o| o.quote_hash).and_then(|h| unhex(&h)) {
                self.used_quotes.insert(h);
            }
            self.mark_submitted(op_id, "await_settlement");
        } else {
            // Funds are in the vault's own Intents balance; nothing was sent to 1Click.
            self.finish_op(op_id, ReceiptStatus::Failed, 0, 0, None, "funding_failed_funds_in_intents_balance");
        }
    }

    /// `ft_withdraw` returns the amount withdrawn (0 if it was refunded inside Intents).
    #[private]
    pub fn on_intents_withdrawn(&mut self, op_id: u64, amount: U128) {
        if external::result_bytes(0).is_none() {
            self.finish_op(op_id, ReceiptStatus::Failed, 0, 0, None, "intents_withdraw_failed");
            return;
        }
        match result_u128(0) {
            Some(0) => self.finish_op(op_id, ReceiptStatus::Failed, 0, 0, None, "intents_withdraw_refunded"),
            Some(got) => self.finish_op(op_id, ReceiptStatus::Settled, got, 0, None, ""),
            None => self.finish_op(op_id, ReceiptStatus::Settled, amount.0, 0, None, "amount_unverified"),
        }
    }

    /// Results: 0 = Intents balance of token_out, 1 = Intents balance of token_in.
    #[private]
    pub fn on_intents_sync(&mut self, op_id: u64) {
        let Some(op) = self.op(op_id) else { return };
        let (Some(out_now), Some(in_now)) = (result_u128(0), result_u128(1)) else {
            env::log_str("intents sync: balances unreadable, retry later");
            return;
        };
        let out_before = op.balance_before.map(|b| b.0).unwrap_or(0);
        let in_before = op.shares_before.map(|b| b.0).unwrap_or(0);
        let received = out_now.saturating_sub(out_before);
        if received > 0 {
            let note = if received < op.min_out.0 { "below_quoted_min_out" } else { "" };
            self.finish_op(op_id, ReceiptStatus::Settled, received, 0, None, note);
        } else if in_now >= in_before.saturating_add(op.amount_in.0) {
            // Refunded into the vault's Intents balance: nothing was spent.
            self.finish_op(op_id, ReceiptStatus::Failed, 0, op.reserved.0, None, "refunded_in_intents_balance");
        } else {
            env::log_str("intents sync: still pending");
        }
    }
}

impl Vault {
    /// Called from `sync_position` when the in-flight op is an Intents route.
    pub(crate) fn sync_intents(&mut self) -> Promise {
        let op = self.in_flight.clone().unwrap();
        require!(op.state == OpState::Submitted, "ERR_OP_NOT_SUBMITTED");
        let since = op.submitted_at.map(|t| t.0).unwrap_or(0);
        require!(env::block_timestamp() >= since + MIN_SYNC_DELAY_NS, "ERR_SYNC_TOO_EARLY");
        let me = env::current_account_id();
        let intents = self.protocols.intents.clone();
        mt_balance_of(&intents, &me, op.token_out.as_ref().unwrap())
            .and(mt_balance_of(&intents, &me, op.token_in.as_ref().unwrap()))
            .then(callback("on_intents_sync", json!({ "op_id": op.op_id.0 }), external::gas::CB_SETTLE))
    }
}

fn mt_balance_of(intents: &AccountId, account: &AccountId, token: &AccountId) -> Promise {
    call(
        intents,
        "mt_balance_of",
        json!({ "account_id": account, "token_id": format!("nep141:{token}") }),
        external::NO_DEPOSIT,
        gas::VIEW,
    )
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

/// "nep141:<account>" → account.
fn nep141_token(asset: &str) -> Option<AccountId> {
    asset.strip_prefix("nep141:")?.parse().ok()
}

/// message = base58(sha256(signed_json)) as ASCII bytes; ed25519 over it.
pub fn verify_quote_signature(signed_json: &str, signature: &str, pubkey: &str) -> bool {
    let (Ok(sig), Ok(pk)) = (math::parse_ed25519_signature(signature), math::parse_ed25519_pubkey(pubkey)) else {
        return false;
    };
    let message = math::base58(&env::sha256_array(signed_json.as_bytes()));
    env::ed25519_verify(&sig, message.as_bytes(), &pk)
}

/// Structural checks; returns the deposit address.
pub fn check_vault_quote(q: &SignedQuote, vault: &AccountId, now_ns: u64) -> Result<AccountId, &'static str> {
    if q.dry {
        return Err("dry quote");
    }
    if q.swap_type != "EXACT_INPUT" {
        return Err("swapType");
    }
    if q.deposit_type != "INTENTS" || q.recipient_type != "INTENTS" || q.refund_type != "INTENTS" {
        return Err("types must be INTENTS");
    }
    if q.recipient != vault.as_str() || q.refund_to != vault.as_str() {
        return Err("recipient/refundTo must be the vault");
    }
    if q.amount != q.amount_in {
        return Err("amount mismatch");
    }
    if q.virtual_chain_recipient.is_some() || q.virtual_chain_refund_recipient.is_some() || q.custom_recipient_msg.is_some() {
        return Err("custom delivery fields not allowed");
    }
    if q.deposit_memo.is_some() {
        return Err("memo deposits not supported");
    }
    let ts = parse_iso8601_utc_ns(&q.timestamp).ok_or("timestamp")?;
    if ts > now_ns + 60_000_000_000 || now_ns.saturating_sub(ts) > MAX_QUOTE_AGE_NS {
        return Err("stale quote");
    }
    let dl = parse_iso8601_utc_ns(q.deadline.as_deref().ok_or("no deadline")?).ok_or("deadline")?;
    if dl <= now_ns + MIN_DEADLINE_MARGIN_NS {
        return Err("deadline too close");
    }
    q.deposit_address.as_deref().ok_or("no depositAddress")?.parse::<AccountId>().map_err(|_| "depositAddress")
}

/// "YYYY-MM-DDTHH:MM:SS[.f{1,9}]Z" → unix ns.
pub fn parse_iso8601_utc_ns(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || *b.last()? != b'Z' || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: core::ops::Range<usize>| -> Option<i64> { core::str::from_utf8(&b[r]).ok()?.parse().ok() };
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut frac_ns = 0i64;
    if b.len() > 20 {
        if b[19] != b'.' {
            return None;
        }
        let f = &s[20..s.len() - 1];
        if f.is_empty() || f.len() > 9 || !f.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        frac_ns = f.parse::<i64>().ok()? * 10i64.pow(9 - f.len() as u32);
    }
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let secs = (era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + mi * 60 + se;
    u64::try_from(secs).ok()?.checked_mul(1_000_000_000)?.checked_add(frac_ns as u64)
}

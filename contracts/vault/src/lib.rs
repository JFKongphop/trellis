//! Trellis policy vault.
//!
//! Holds one user's funds. The owner sets a `Policy`; an agent account may call `agent_*` methods,
//! and every one of them is checked against the policy on-chain before any funds move.
//! Spec: docs/vault-spec.md.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap, LookupSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};

pub mod events;
pub mod external;
mod intents;
mod lending;
pub mod math;
mod owner;
pub mod policy;
mod swap;
pub mod types;

pub use policy::Policy;
pub use types::*;

use events::{ActionData, VaultEvent};

/// Ops older than this can be cleared by the owner.
pub const STALE_LOCK_NS: u64 = 15 * 60 * 1_000_000_000;
/// `sync_position` waits at least this long after submission so external receipts have settled.
pub const MIN_SYNC_DELAY_NS: u64 = 5 * 1_000_000_000;
/// A borrow / withdraw that shows no effect is only declared "not executed" after this long.
/// Burrow runs it in detached receipts that can lag under congestion; finishing early would let
/// the agent stack a second borrow on top of a pending one (well past Burrow's 60 s price validity).
pub const SYNC_FINAL_NS: u64 = 3 * 60 * 1_000_000_000;
pub const MAX_RECEIPTS: u32 = 50;
/// Every registered token adds an oracle view to the borrow precheck; 5 keeps a borrow under 300 Tgas.
pub const MAX_REGISTERED_TOKENS: usize = 5;
pub const MAX_REASON_LEN: usize = 128;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Tokens,
    Spent,
    Receipts,
    UsedQuotes,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    protocols: Protocols,
    policy: Policy,
    agent: Option<AccountId>,
    agent_expires_at: Option<u64>,
    paused: bool,
    tokens: IterableMap<AccountId, TokenInfo>,
    /// Outflow reserved/used per (token, day index).
    spent: LookupMap<(AccountId, u64), u128>,
    in_flight: Option<PendingOp>,
    next_op_id: u64,
    receipts: Vector<ReceiptView>,
    receipts_head: u32,
    storage_spent: u128,
    last_health: Option<HealthSnapshot>,
    /// sha256 of every 1Click quote already funded (replay protection).
    used_quotes: LookupSet<[u8; 32]>,
    /// Deleverage cycle in progress (see `PendingDeleverage`).
    deleverage: Option<PendingDeleverage>,
}

#[near]
impl Vault {
    /// Called by the factory in the same batch that creates and deploys the vault.
    /// `protocols` defaults to the mainnet contracts; it can't be changed later.
    #[init]
    pub fn new(owner: AccountId, protocols: Option<Protocols>) -> Self {
        require!(owner != env::current_account_id(), "Owner can't be the vault itself");
        Self {
            owner,
            protocols: protocols.unwrap_or_else(Protocols::mainnet),
            policy: Policy::default(),
            agent: None,
            agent_expires_at: None,
            paused: false,
            tokens: IterableMap::new(StorageKey::Tokens),
            spent: LookupMap::new(StorageKey::Spent),
            in_flight: None,
            next_op_id: 1,
            receipts: Vector::new(StorageKey::Receipts),
            receipts_head: 0,
            storage_spent: 0,
            last_health: None,
            used_quotes: LookupSet::new(StorageKey::UsedQuotes),
            deleverage: None,
        }
    }

    // ---------------- deposits ----------------

    /// NEP-141 receiver. Accepts only registered tokens; anything else is refunded.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        let token = env::predecessor_account_id();
        if !self.tokens.contains_key(&token) {
            return PromiseOrValue::Value(amount);
        }
        VaultEvent::Deposit { token, amount, sender: sender_id }.emit();
        PromiseOrValue::Value(U128(0))
    }

    // ---------------- views ----------------

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_protocols(&self) -> Protocols {
        self.protocols.clone()
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_status(&self) -> VaultStatus {
        VaultStatus {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            agent_expires_at: self.agent_expires_at.map(U64),
            paused: self.paused,
            in_flight: self.in_flight.clone(),
            near_available: U128(self.available_near()),
            storage_spent: U128(self.storage_spent),
            last_health: self.last_health.clone(),
            day: U64(math::day_index(env::block_timestamp())),
            pending_deleverage: self.deleverage.clone(),
        }
    }

    /// Remaining outflow allowed today for `token` (0 if the token has no cap = not spendable).
    pub fn remaining_daily(&self, token: AccountId) -> U128 {
        let cap = self.policy.daily_cap_of(&token).unwrap_or(0);
        let used = self.spent_today(&token);
        U128(cap.saturating_sub(used))
    }

    pub fn get_tokens(&self) -> Vec<(AccountId, TokenInfo)> {
        self.tokens.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// Most recent receipts first.
    pub fn get_receipts(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<ReceiptView> {
        let len = self.receipts.len();
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_RECEIPTS).min(MAX_RECEIPTS);
        // `receipts_head` is the oldest slot once the buffer is full (0 before that),
        // so the i-th newest receipt is at (head + len - 1 - i) mod len.
        (from..len.min(from.saturating_add(limit)))
            .filter_map(|i| self.receipts.get((self.receipts_head + len - 1 - i) % len).cloned())
            .collect()
    }
}

#[near(serializers = [json])]
pub struct VaultStatus {
    pub owner: AccountId,
    pub agent: Option<AccountId>,
    pub agent_expires_at: Option<U64>,
    pub paused: bool,
    pub in_flight: Option<PendingOp>,
    pub near_available: U128,
    pub storage_spent: U128,
    pub last_health: Option<HealthSnapshot>,
    pub day: U64,
    pub pending_deleverage: Option<PendingDeleverage>,
}

// ---------------- internal helpers ----------------
impl Vault {
    pub(crate) fn assert_owner(&self) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
    }

    fn is_agent(&self) -> bool {
        let caller = env::predecessor_account_id();
        if self.agent.as_ref() != Some(&caller) {
            return false;
        }
        match self.agent_expires_at {
            Some(exp) => env::block_timestamp() < exp,
            None => true,
        }
    }

    /// Common checks for every agent action (spec §5.3, steps 1–4).
    pub(crate) fn assert_agent_action(&self, reason_hash: &str) {
        require!(self.is_agent(), "ERR_NOT_AGENT");
        require!(!self.paused, "ERR_PAUSED");
        require!(self.in_flight.is_none(), "ERR_OP_IN_FLIGHT");
        require!(reason_hash.len() <= MAX_REASON_LEN, "ERR_REASON_TOO_LONG");
    }

    /// Agent or owner (used by recovery/sync methods). Owner calls don't need 1 yocto here
    /// because they only move funds back into the vault.
    pub(crate) fn assert_agent_or_owner(&self) -> bool {
        let caller = env::predecessor_account_id();
        if caller == self.owner {
            return true;
        }
        require!(self.is_agent(), "ERR_NOT_AGENT_OR_OWNER");
        false
    }

    pub(crate) fn assert_allowed_token(&self, token: &AccountId) -> TokenInfo {
        require!(self.policy.is_allowed(token), "ERR_TOKEN_NOT_ALLOWED");
        self.tokens.get(token).cloned().unwrap_or_else(|| env::panic_str("ERR_TOKEN_NOT_REGISTERED"))
    }

    fn spent_today(&self, token: &AccountId) -> u128 {
        let day = math::day_index(env::block_timestamp());
        self.spent.get(&(token.clone(), day)).copied().unwrap_or(0)
    }

    /// Reserve an outflow against the per-action and daily caps. Panics (no state change) if over.
    pub(crate) fn reserve_outflow(&mut self, token: &AccountId, amount: u128) -> u64 {
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        let per = self.policy.per_action_cap_of(token).unwrap_or_else(|| env::panic_str("ERR_TOKEN_NOT_CAPPED"));
        let daily = self.policy.daily_cap_of(token).unwrap_or_else(|| env::panic_str("ERR_TOKEN_NOT_CAPPED"));
        require!(amount <= per, "ERR_PER_ACTION_CAP");
        let day = math::day_index(env::block_timestamp());
        let key = (token.clone(), day);
        let used = self.spent.get(&key).copied().unwrap_or(0);
        let new_used = used.checked_add(amount).unwrap_or_else(|| env::panic_str("ERR_OVERFLOW"));
        require!(new_used <= daily, "ERR_DAILY_CAP");
        self.spent.insert(key, new_used);
        day
    }

    /// Release (part of) a reservation. Never panics.
    pub(crate) fn release_outflow(&mut self, token: &AccountId, day: u64, amount: u128) {
        if amount == 0 {
            return;
        }
        if let Some(used) = self.spent.get_mut(&(token.clone(), day)) {
            *used = used.saturating_sub(amount);
        }
    }

    /// NEAR the vault can spend without touching storage staking.
    pub(crate) fn available_near(&self) -> u128 {
        let storage = (env::storage_usage() as u128).saturating_mul(env::storage_byte_cost().as_yoctonear());
        env::account_balance().as_yoctonear().saturating_sub(storage)
    }

    /// Ensure spending `amount` NEAR keeps `min_near_reserve` available.
    pub(crate) fn assert_near_spendable(&self, amount: u128) {
        let after = self.available_near().checked_sub(amount).unwrap_or_else(|| env::panic_str("ERR_NOT_ENOUGH_NEAR"));
        require!(after >= self.policy.min_near_reserve.as_yoctonear(), "ERR_NEAR_RESERVE");
    }

    pub(crate) fn spend_storage(&mut self, amount: NearToken) {
        let total = self.storage_spent.saturating_add(amount.as_yoctonear());
        require!(total <= self.policy.max_storage_spend.as_yoctonear(), "ERR_STORAGE_SPEND_LIMIT");
        self.assert_near_spendable(amount.as_yoctonear());
        self.storage_spent = total;
    }

    /// Start an agent op (takes the lock) and emit `action_started`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn begin_op(
        &mut self,
        kind: OpKind,
        token_in: Option<AccountId>,
        amount_in: u128,
        token_out: Option<AccountId>,
        reserved: u128,
        day: u64,
        reason_hash: String,
    ) -> u64 {
        let op_id = self.next_op_id;
        self.next_op_id += 1;
        let op = PendingOp {
            op_id: U64(op_id),
            kind,
            state: OpState::Started,
            started_at: U64(env::block_timestamp()),
            submitted_at: None,
            token_in,
            amount_in: U128(amount_in),
            token_out,
            reserved: U128(reserved),
            day: U64(day),
            reason_hash,
            pool_id: None,
            min_out: U128(0),
            balance_before: None,
            shares_before: None,
            deposit_address: None,
            deleverage: false,
            funds_sent: false,
            quote_hash: None,
        };
        VaultEvent::ActionStarted(vec![action_data(&op, 0, None, String::new())]).emit();
        self.in_flight = Some(op);
        // State written so far (lock, cap reservation) must not eat into the NEAR reserve, so callbacks
        // that add storage later can always pay for it.
        self.assert_near_spendable(0);
        op_id
    }

    /// Record that funds are about to leave the vault (no event; see `PendingOp::funds_sent`).
    pub(crate) fn mark_funds_sent(&mut self, op_id: u64) {
        if let Some(op) = self.op_mut(op_id) {
            op.funds_sent = true;
        }
    }

    /// While a deleverage cycle is open, only methods that finish it are allowed.
    pub(crate) fn assert_no_deleverage_pending(&self) {
        require!(self.deleverage.is_none(), "ERR_DELEVERAGE_PENDING");
    }

    /// Clears the pending deleverage once nothing is left to swap or repay.
    pub(crate) fn maybe_finish_deleverage(&mut self) {
        if let Some(d) = &self.deleverage {
            if d.collateral_left.0 == 0 && d.repay_due.0 == 0 {
                env::log_str("deleverage cycle complete");
                self.deleverage = None;
            }
        }
    }

    /// The in-flight op if it matches `op_id` (callbacks use this; never panics).
    pub(crate) fn op(&self, op_id: u64) -> Option<PendingOp> {
        self.in_flight.as_ref().filter(|o| o.op_id.0 == op_id).cloned()
    }

    pub(crate) fn op_mut(&mut self, op_id: u64) -> Option<&mut PendingOp> {
        self.in_flight.as_mut().filter(|o| o.op_id.0 == op_id)
    }

    pub(crate) fn mark_submitted(&mut self, op_id: u64, note: &str) {
        if let Some(op) = self.op_mut(op_id) {
            op.state = OpState::Submitted;
            op.submitted_at = Some(U64(env::block_timestamp()));
            let op = op.clone();
            VaultEvent::ActionSubmitted(vec![action_data(&op, 0, None, note.to_string())]).emit();
        }
    }

    /// Finish the in-flight op: release `release` of its reservation, record a receipt, emit, unlock.
    pub(crate) fn finish_op(
        &mut self,
        op_id: u64,
        status: ReceiptStatus,
        amount_out: u128,
        release: u128,
        health: Option<u64>,
        note: &str,
    ) {
        let Some(op) = self.op(op_id) else { return };
        if let Some(t) = &op.token_in {
            self.release_outflow(t, op.day.0, release.min(op.reserved.0));
        }
        let data = action_data(&op, amount_out, health, note.to_string());
        match status {
            ReceiptStatus::Settled => VaultEvent::ActionSettled(vec![data]).emit(),
            ReceiptStatus::Failed => VaultEvent::ActionFailed(vec![data]).emit(),
        }
        self.push_receipt(ReceiptView {
            op_id: op.op_id,
            kind: op.kind,
            status,
            token_in: op.token_in.clone(),
            amount_in: op.amount_in,
            token_out: op.token_out.clone(),
            amount_out: U128(amount_out),
            health_factor_bps: health.map(U64),
            note: note.to_string(),
            reason_hash: op.reason_hash.clone(),
            timestamp: U64(env::block_timestamp()),
        });
        self.in_flight = None;
    }

    fn push_receipt(&mut self, r: ReceiptView) {
        if self.receipts.len() < MAX_RECEIPTS {
            self.receipts.push(r);
        } else {
            self.receipts.replace(self.receipts_head, r);
            self.receipts_head = (self.receipts_head + 1) % MAX_RECEIPTS;
        }
    }

    pub(crate) fn record_health(&mut self, hf: u64, coll: math::U256, debt: math::U256) {
        self.last_health = Some(HealthSnapshot {
            health_factor_bps: U64(hf),
            collateral_usd_e18: U128(math::to_u128(coll)),
            debt_usd_e18: U128(math::to_u128(debt)),
            timestamp: U64(env::block_timestamp()),
        });
        if hf < self.policy.min_health_factor_bps as u64 {
            VaultEvent::HealthAlert {
                health_factor_bps: U64(hf),
                min_health_factor_bps: U64(self.policy.min_health_factor_bps as u64),
            }
            .emit();
        }
    }
}

pub(crate) fn action_data(op: &PendingOp, amount_out: u128, health: Option<u64>, note: String) -> ActionData {
    ActionData {
        op_id: op.op_id,
        kind: op.kind,
        token_in: op.token_in.clone(),
        amount_in: op.amount_in,
        token_out: op.token_out.clone(),
        amount_out: U128(amount_out),
        health_factor_bps: health.map(U64),
        note,
        reason_hash: op.reason_hash.clone(),
    }
}

#[cfg(test)]
mod tests;

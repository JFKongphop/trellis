//! Owner methods: every one checks `predecessor == owner` and exactly 1 yocto attached
//! (forces a full-access-key / wallet-confirmed signature; the agent can never call these).
//! They work while paused, and withdrawals never depend on Burrow / Ref / Intents.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::events::VaultEvent;
use crate::external::{self, call, callback, gas, result_json, ONE_YOCTO};
use crate::types::{OpState, ReceiptStatus, TokenInfo};
use crate::{Policy, Vault, VaultExt, MAX_REGISTERED_TOKENS, STALE_LOCK_NS};

/// Attached to each token `storage_deposit` (registration_only = true refunds the excess).
const TOKEN_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);
const BURROW_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(150);
const REF_STORAGE_BASE: NearToken = NearToken::from_millinear(10);
const REF_STORAGE_PER_TOKEN: NearToken = NearToken::from_millinear(2);

#[near]
impl Vault {
    #[payable]
    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        if let Err(e) = policy.validate() {
            env::panic_str(&format!("ERR_INVALID_POLICY: {e}"));
        }
        self.policy = policy;
        VaultEvent::PolicyChanged.emit();
    }

    #[payable]
    pub fn set_agent(&mut self, agent: AccountId, expires_at: Option<U64>) {
        self.assert_owner();
        require!(agent != self.owner && agent != env::current_account_id(), "ERR_BAD_AGENT");
        if let Some(e) = expires_at {
            require!(e.0 > env::block_timestamp(), "ERR_EXPIRY_IN_PAST");
        }
        self.agent = Some(agent.clone());
        self.agent_expires_at = expires_at.map(|e| e.0);
        VaultEvent::AgentSet { agent, expires_at }.emit();
    }

    /// Instant: the agent can no longer call anything.
    #[payable]
    pub fn revoke_agent(&mut self) {
        self.assert_owner();
        self.agent = None;
        self.agent_expires_at = None;
        VaultEvent::AgentRevoked.emit();
    }

    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        VaultEvent::Paused.emit();
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        VaultEvent::Unpaused.emit();
    }

    /// Registers a token: reads decimals (`ft_metadata`), Burrow asset config and oracle price id,
    /// and registers the vault's storage on the token. All four results are checked in the callback.
    #[payable]
    pub fn register_token(&mut self, token: AccountId) -> Promise {
        self.assert_owner();
        require!(
            self.tokens.contains_key(&token) || self.tokens.len() < MAX_REGISTERED_TOKENS as u32,
            "ERR_TOO_MANY_TOKENS"
        );
        self.spend_storage(TOKEN_STORAGE_DEPOSIT);
        let me = env::current_account_id();
        let burrow = self.protocols.burrow.clone();
        external::join(vec![
            call(&token, "ft_metadata", json!({}), external::NO_DEPOSIT, gas::VIEW),
            call(&burrow, "get_asset", json!({ "token_id": token }), external::NO_DEPOSIT, gas::VIEW),
            call(&burrow, "get_token_pyth_info", json!({ "token_id": token }), external::NO_DEPOSIT, gas::VIEW),
            call(
                &token,
                "storage_deposit",
                json!({ "account_id": me, "registration_only": true }),
                TOKEN_STORAGE_DEPOSIT,
                gas::STORAGE_DEPOSIT,
            ),
        ])
        .then(callback("on_token_registered", json!({ "token": token }), gas::CB_SETTLE))
    }

    #[private]
    pub fn on_token_registered(&mut self, token: AccountId) -> bool {
        let parsed = (|| {
            let meta = result_json(0)?;
            let asset = result_json(1)?;
            let pyth = result_json(2)?;
            result_json(3)?; // storage_deposit must have succeeded
            let decimals = meta.get("decimals")?.as_u64()? as u8;
            let cfg = asset.get("config")?;
            let extra = cfg.get("extra_decimals")?.as_u64()? as u8;
            let vol = cfg.get("volatility_ratio")?.as_u64()? as u32;
            let price_id = pyth.get("price_identifier")?.as_str()?.to_string();
            if price_id.len() != 64 || vol == 0 || vol > 10_000 {
                return None;
            }
            Some(TokenInfo { decimals, burrow_extra_decimals: extra, price_id, volatility_ratio_bps: vol })
        })();
        match parsed {
            Some(info) => {
                self.tokens.insert(token.clone(), info);
                VaultEvent::TokenRegistered { token }.emit();
                true
            }
            None => {
                env::log_str(&format!("register_token failed for {token}"));
                false
            }
        }
    }

    /// One-time protocol setup: storage on Burrow and Ref, and register all known tokens on Ref.
    /// Runs as a chain (Ref `register_tokens` needs the Ref storage deposit first).
    #[payable]
    pub fn setup_protocols(&mut self) -> Promise {
        self.assert_owner();
        let n = self.tokens.len() as u128;
        let ref_storage = REF_STORAGE_BASE.saturating_add(REF_STORAGE_PER_TOKEN.saturating_mul(n));
        self.spend_storage(BURROW_STORAGE_DEPOSIT.saturating_add(ref_storage));
        let token_ids: Vec<AccountId> = self.tokens.keys().cloned().collect();
        let burrow = self.protocols.burrow.clone();
        let refx = self.protocols.ref_exchange.clone();
        call(
            &burrow,
            "storage_deposit",
            json!({ "account_id": Value::Null, "registration_only": false }),
            BURROW_STORAGE_DEPOSIT,
            gas::STORAGE_DEPOSIT,
        )
        .then(call(
            &refx,
            "storage_deposit",
            json!({ "account_id": Value::Null, "registration_only": false }),
            ref_storage,
            gas::STORAGE_DEPOSIT,
        ))
        .then(call(&refx, "register_tokens", json!({ "token_ids": token_ids }), ONE_YOCTO, gas::REF_REGISTER))
    }

    /// NEAR back to the owner only. Storage staking always stays covered.
    #[payable]
    pub fn withdraw_near(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0 && amount.0 <= self.available_near(), "ERR_NOT_ENOUGH_NEAR");
        VaultEvent::OwnerWithdraw { token: None, amount }.emit();
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Tokens back to the owner only. No dependency on any protocol.
    #[payable]
    pub fn withdraw_ft(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        VaultEvent::OwnerWithdraw { token: Some(token.clone()), amount }.emit();
        call(
            &token,
            "ft_transfer",
            json!({ "receiver_id": self.owner, "amount": amount, "memo": "trellis owner withdraw" }),
            ONE_YOCTO,
            gas::FT_TRANSFER,
        )
    }

    /// Owner-signed passthrough to Burrow (e.g. close the position manually).
    /// The policy limits the agent, not the owner.
    #[payable]
    pub fn owner_burrow(&mut self, actions: Value, with_prices: bool) -> Promise {
        self.assert_owner();
        // an agent op being reconciled would count this change as its own
        require!(self.in_flight.is_none(), "ERR_OP_IN_FLIGHT");
        let method = if with_prices { "execute_with_pyth" } else { "execute" };
        let g = if with_prices { gas::BURROW_EXECUTE_WITH_PYTH } else { gas::BURROW_EXECUTE };
        call(&self.protocols.burrow, method, json!({ "actions": actions }), ONE_YOCTO, g)
    }

    /// Owner-signed `ft_transfer_call` from the vault to one of the protocol contracts
    /// (e.g. repay Burrow debt with msg "\"OnlyRepay\"" after revoking the agent).
    #[payable]
    pub fn owner_ft_transfer_call(&mut self, token: AccountId, receiver: AccountId, amount: U128, msg: String) -> Promise {
        self.assert_owner();
        require!(self.in_flight.is_none(), "ERR_OP_IN_FLIGHT");
        let p = &self.protocols;
        require!(
            receiver == p.burrow || receiver == p.ref_exchange || receiver == p.intents,
            "ERR_RECEIVER_NOT_PROTOCOL"
        );
        call(
            &token,
            "ft_transfer_call",
            json!({ "receiver_id": receiver, "amount": amount, "msg": msg }),
            ONE_YOCTO,
            gas::FT_TRANSFER_CALL,
        )
    }

    /// Owner-signed withdrawal of the vault's NEAR Intents balance back into the vault.
    /// No `msg` → the withdrawal is refunded inside Intents if the transfer fails.
    #[payable]
    pub fn owner_intents_withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        call(
            &self.protocols.intents,
            "ft_withdraw",
            json!({ "token": token, "receiver_id": env::current_account_id(), "amount": amount }),
            ONE_YOCTO,
            gas::INTENTS_WITHDRAW,
        )
    }

    /// Clears a stuck operation after `STALE_LOCK_NS`. The cap reservation is released only if
    /// nothing left the vault (state `Started` and no transfer fired).
    #[payable]
    pub fn clear_stale_lock(&mut self, op_id: U64) {
        self.assert_owner();
        let op = self.op(op_id.0).unwrap_or_else(|| env::panic_str("ERR_NO_SUCH_OP"));
        require!(env::block_timestamp() >= op.started_at.0 + STALE_LOCK_NS, "ERR_LOCK_NOT_STALE");
        let release = if op.state == OpState::Started && !op.funds_sent { op.reserved.0 } else { 0 };
        self.finish_op(op_id.0, ReceiptStatus::Failed, 0, release, None, "cleared_by_owner");
        VaultEvent::LockCleared { op_id }.emit();
    }

    /// Ends a pending deleverage cycle (e.g. after the owner repaid or added collateral by hand).
    #[payable]
    pub fn clear_deleverage(&mut self) {
        self.assert_owner();
        self.deleverage = None;
        env::log_str("deleverage cycle cleared by owner");
    }

    /// Upgrade to a new global contract code hash (base58), then call `migrate`.
    /// Only the owner can upgrade their vault; the factory has no rights.
    #[payable]
    pub fn upgrade(&mut self, code_hash: String) -> Promise {
        self.assert_owner();
        require!(self.in_flight.is_none(), "ERR_OP_IN_FLIGHT");
        let hash: [u8; 32] = bs58::decode(&code_hash)
            .into_vec()
            .ok()
            .and_then(|b| b.try_into().ok())
            .unwrap_or_else(|| env::panic_str("ERR_BAD_CODE_HASH"));
        Promise::new(env::current_account_id())
            .use_global_contract(hash)
            .function_call("migrate".to_string(), b"{}".to_vec(), external::NO_DEPOSIT, gas::CB_SETTLE)
    }

    /// State migration hook for upgrades (no-op for v1 → v1).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("ERR_NO_STATE"))
    }

    pub fn get_spent(&self, token: AccountId, day: U64) -> U128 {
        U128(self.spent.get(&(token, day.0)).copied().unwrap_or(0))
    }
}

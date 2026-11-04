//! Trellis factory: creates one policy vault per user as a subaccount `v<16 hex>.<factory>`.
//!
//! The vault is created, funded, given code and initialized in ONE atomic batch, with no access keys.
//! After that the factory has no rights over it: only the vault's owner can change or upgrade it.
//!
//! Two code modes:
//! - `Global`: vaults reference a NEP-591 global contract by **code hash** (cheap per vault; publishing
//!   the global contract burns ~10 NEAR per 100 kB once). Never by account id: that would let the
//!   publisher upgrade every vault.
//! - `Local`: the factory stores the wasm and deploys a copy into each vault (each vault locks ~1 NEAR
//!   per 100 kB of code for storage).
use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};

const CODE_KEY: &[u8] = b"CODE";
/// NEAR the new vault keeps for its own state, the policy reserve, and protocol storage deposits.
const VAULT_OPERATING_NEAR: NearToken = NearToken::from_millinear(1_500);
const GAS_INIT: Gas = Gas::from_tgas(30);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Vaults,
    Refunds,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CodeMode {
    Global { code_hash: Base58CryptoHash },
    Local,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    admin: AccountId,
    mode: CodeMode,
    /// owner → vault
    vaults: LookupMap<AccountId, AccountId>,
    vault_count: u64,
    /// Deposits of failed creations that couldn't be sent back right away (claim with `claim_refund`).
    refunds: LookupMap<AccountId, u128>,
}

#[near]
impl Factory {
    #[init]
    pub fn new(admin: AccountId, mode: CodeMode) -> Self {
        Self {
            admin,
            mode,
            vaults: LookupMap::new(StorageKey::Vaults),
            vault_count: 0,
            refunds: LookupMap::new(StorageKey::Refunds),
        }
    }

    /// Admin: switch the code used for NEW vaults. Existing vaults are unaffected.
    pub fn set_mode(&mut self, mode: CodeMode) {
        require!(env::predecessor_account_id() == self.admin, "ERR_NOT_ADMIN");
        self.mode = mode;
    }

    /// Admin: store the vault wasm for `Local` mode. Call with the raw wasm bytes as input
    /// (e.g. `near contract call-function ... set_code file-args vault.wasm`).
    pub fn set_code(&mut self) {
        require!(env::predecessor_account_id() == self.admin, "ERR_NOT_ADMIN");
        let code = env::input().unwrap_or_default();
        require!(code.len() > 1_000 && code.starts_with(b"\0asm"), "ERR_NOT_WASM");
        env::storage_write(CODE_KEY, &code);
    }

    /// Admin: publish the vault wasm (raw input bytes) as a NEP-591 global contract, referenced by its
    /// code hash, and switch NEW vaults to it once publishing succeeds. Burns ~10 NEAR per 100 kB from
    /// the factory balance (one time). Vaults keep referencing the hash, so no one can change their code
    /// except each vault's owner via `upgrade`.
    pub fn publish_global_code(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.admin, "ERR_NOT_ADMIN");
        let code = env::input().unwrap_or_default();
        require!(code.len() > 1_000 && code.starts_with(b"\0asm"), "ERR_NOT_WASM");
        let hash: Base58CryptoHash = env::sha256_array(&code).into();
        Promise::new(env::current_account_id()).deploy_global_contract(code).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .with_unused_gas_weight(0)
                .on_global_published(hash),
        )
    }

    #[private]
    pub fn on_global_published(&mut self, code_hash: Base58CryptoHash) -> bool {
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 1024).is_ok();
        if ok {
            self.mode = CodeMode::Global { code_hash };
            env::log_str(&format!("vault code published globally: {}", String::from(&code_hash)));
        }
        ok
    }

    /// Creates the caller's vault. Attach at least `get_min_deposit()`; everything attached goes to the
    /// vault (minus nothing). Returns the vault account id via the callback.
    #[payable]
    pub fn create_vault(&mut self) -> Promise {
        let owner = env::predecessor_account_id();
        require!(!self.vaults.contains_key(&owner), "ERR_VAULT_EXISTS");
        let deposit = env::attached_deposit();
        require!(deposit >= self.min_deposit(), "ERR_DEPOSIT_TOO_SMALL");
        let vault = vault_account_id(&owner, &env::current_account_id());
        self.vaults.insert(owner.clone(), vault.clone());

        let batch = Promise::new(vault.clone()).create_account().transfer(deposit);
        let batch = match &self.mode {
            CodeMode::Global { code_hash } => batch.use_global_contract(*code_hash),
            CodeMode::Local => {
                let code = env::storage_read(CODE_KEY).unwrap_or_else(|| env::panic_str("ERR_NO_CODE"));
                batch.deploy_contract(code)
            }
        };
        batch
            .function_call(
                "new".to_string(),
                json!({ "owner": owner }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_INIT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_vault_created(owner, vault, U128(deposit.as_yoctonear())),
            )
    }

    /// If the batch failed, the attached NEAR comes back to the factory in a separate refund receipt
    /// that may not have arrived yet. Forget the vault (so the owner can retry) and pay the deposit
    /// back now if the factory's free balance covers it; otherwise record it for `claim_refund`.
    #[private]
    pub fn on_vault_created(
        &mut self,
        owner: AccountId,
        vault: AccountId,
        deposit: U128,
    ) -> Option<AccountId> {
        // Read the raw result: `new` returns empty bytes, which a typed `()` callback could fail to decode.
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 1024).is_ok();
        if ok {
            self.vault_count += 1;
            env::log_str(&format!("vault {vault} created for {owner}"));
            Some(vault)
        } else {
            self.vaults.remove(&owner);
            // keep 1 NEAR of headroom so the factory never dips into its own storage staking
            if self.free_balance() >= deposit.0.saturating_add(NearToken::from_near(1).as_yoctonear()) {
                Promise::new(owner).transfer(NearToken::from_yoctonear(deposit.0)).detach();
            } else {
                let due = self.refunds.get(&owner).copied().unwrap_or(0).saturating_add(deposit.0);
                self.refunds.insert(owner.clone(), due);
                env::log_str(&format!("refund of {} yocto recorded for {owner}: call claim_refund", deposit.0));
            }
            None
        }
    }

    /// Pays out a refund recorded by a failed `create_vault`.
    pub fn claim_refund(&mut self) -> Promise {
        let owner = env::predecessor_account_id();
        let due = self.refunds.remove(&owner).unwrap_or_else(|| env::panic_str("ERR_NO_REFUND"));
        Promise::new(owner).transfer(NearToken::from_yoctonear(due))
    }

    pub fn get_refund(&self, owner: AccountId) -> U128 {
        U128(self.refunds.get(&owner).copied().unwrap_or(0))
    }

    // ---------------- views ----------------

    pub fn get_vault(&self, owner: AccountId) -> Option<AccountId> {
        self.vaults.get(&owner).cloned()
    }

    /// Where the vault for `owner` will be (or is).
    pub fn vault_id_for(&self, owner: AccountId) -> AccountId {
        vault_account_id(&owner, &env::current_account_id())
    }

    pub fn get_min_deposit(&self) -> NearToken {
        self.min_deposit()
    }

    pub fn get_mode(&self) -> CodeMode {
        self.mode.clone()
    }

    pub fn get_vault_count(&self) -> u64 {
        self.vault_count
    }
}

impl Factory {
    fn free_balance(&self) -> u128 {
        let storage = (env::storage_usage() as u128).saturating_mul(env::storage_byte_cost().as_yoctonear());
        env::account_balance().as_yoctonear().saturating_sub(storage)
    }

    fn min_deposit(&self) -> NearToken {
        let code_storage = match self.mode {
            CodeMode::Global { .. } => 0,
            CodeMode::Local => {
                // storage_read of a large value costs gas; length is enough here
                let len = env::storage_read(CODE_KEY).map(|c| c.len()).unwrap_or(0) as u128;
                len * env::storage_byte_cost().as_yoctonear()
            }
        };
        VAULT_OPERATING_NEAR.saturating_add(NearToken::from_yoctonear(code_storage))
    }
}

/// `v` + first 16 hex chars of sha256(owner). Readable names like "alice-near" are unsafe:
/// "alice.bob.near" and "alice-bob.near" would collide.
pub fn vault_account_id(owner: &AccountId, factory: &AccountId) -> AccountId {
    let h = env::sha256_array(owner.as_bytes());
    let hex: String = h.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("v{hex}.{factory}").parse().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(pred: &str, deposit: NearToken) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("trellis.near".parse().unwrap())
            .predecessor_account_id(pred.parse().unwrap())
            .attached_deposit(deposit);
        testing_env!(b.build());
    }

    #[test]
    fn names_are_distinct_and_valid() {
        ctx("x.near", NearToken::from_near(0));
        let f: AccountId = "trellis.near".parse().unwrap();
        let a = vault_account_id(&"alice.bob.near".parse().unwrap(), &f);
        let b = vault_account_id(&"alice-bob.near".parse().unwrap(), &f);
        assert_ne!(a, b);
        assert!(a.as_str().starts_with('v') && a.as_str().ends_with(".trellis.near"));
        assert_eq!(a.as_str().len(), 17 + 1 + "trellis.near".len());
    }

    #[test]
    #[should_panic(expected = "ERR_VAULT_EXISTS")]
    fn one_vault_per_owner() {
        ctx("admin.near", NearToken::from_near(0));
        let mut f = Factory::new("admin.near".parse().unwrap(), CodeMode::Global { code_hash: [7u8; 32].into() });
        ctx("alice.near", NearToken::from_near(2));
        let _ = f.create_vault();
        let _ = f.create_vault();
    }

    #[test]
    #[should_panic(expected = "ERR_DEPOSIT_TOO_SMALL")]
    fn needs_deposit() {
        ctx("admin.near", NearToken::from_near(0));
        let mut f = Factory::new("admin.near".parse().unwrap(), CodeMode::Global { code_hash: [7u8; 32].into() });
        ctx("alice.near", NearToken::from_millinear(100));
        let _ = f.create_vault();
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ADMIN")]
    fn only_admin_sets_mode() {
        ctx("admin.near", NearToken::from_near(0));
        let mut f = Factory::new("admin.near".parse().unwrap(), CodeMode::Local);
        ctx("mallory.near", NearToken::from_near(0));
        f.set_mode(CodeMode::Local);
    }
}

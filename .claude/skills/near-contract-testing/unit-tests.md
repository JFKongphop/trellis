# Unit tests with near-sdk 5.29 (`testing_env!`)

Unit tests run the contract as a normal Rust library against a **mocked blockchain**. Contract storage persists across `testing_env!` calls inside one test, and each `#[test]` gets a fresh thread-local mock. Use them for logic: policy validation, caps, day math, HF and min_out math, owner/agent checks written in method bodies, emitted events, and the shape of outgoing receipts.

Things they do **not** cover, so test these in the sandbox (`sandbox-integration.md`):
- `#[private]` and the implicit non-payable check (they live in the wasm export wrapper).
- Real cross-contract execution.
- Gas.
- Refunds.
- Storage staking failures.

## Cargo.toml

```toml
[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
near-sdk = "5.29.1"

[dev-dependencies]
near-sdk = { version = "5.29.1", features = ["unit-testing"] }

[lints.rust.unexpected_cfgs]
level = "warn"
check-cfg = ['cfg(near)']
```

Run with `cargo test` on the host target. No wasm target is needed.

## API cheat sheet (near-sdk 5.29.1, `near_sdk::test_utils`)

| Item | What it does |
|---|---|
| `VMContextBuilder::new()` | Defaults: `current_account_id = "alice"`, `signer = predecessor = "bob"`, `block_timestamp = 0`, `account_balance = 100 NEAR`, `attached_deposit = 0`, `prepaid_gas = 1000 Tgas`. |
| `.current_account_id(id)` / `.predecessor_account_id(id)` / `.signer_account_id(id)` / `.signer_account_pk(pk)` | Set who calls and who is called. |
| `.attached_deposit(NearToken)` / `.account_balance(NearToken)` / `.account_locked_balance(..)` / `.storage_usage(u64)` | Set balances and storage. |
| `.block_timestamp(ns)` / `.block_height(h)` / `.epoch_height(e)` / `.prepaid_gas(Gas)` / `.random_seed([u8;32])` / `.is_view(bool)` | Set block data and gas. Each setter returns `&mut Self`, so call `.build()` last. |
| `testing_env!(ctx)` | Install the context and keep existing storage. |
| `testing_env!(ctx, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), HashMap::default(), vec![PromiseResult::..])` | The 5-arg form mocks `env::promise_result(i)` for code that reads promise results manually. |
| `get_logs() -> Vec<String>` | Logs written since the last `testing_env!`. Events appear as `EVENT_JSON:{...}`. |
| `get_created_receipts() -> Vec<near_sdk::mock::Receipt>` | Each receipt has `receiver_id`, `receipt_indices`, and `actions: Vec<MockAction>`. |
| `near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, gas_weight, .. }` | Match on this to check outgoing calls. Other variants include `Transfer`, `CreateAccount`, `DeployContract`, `UseGlobalContract`, `AddKeyWithFunctionCall`, and more. |
| `accounts(i)` | Returns `"alice","bob","charlie","danny","eugene","fargo"`. Prefer realistic ids like `"agent.trellis.near"`. |

`testing_env_with_promise_results` is deprecated. Use the 5-arg macro.

## Verified example: a mini vault with its tests

The code below, as printed, compiles and passes (7/7) with near-sdk 5.29.1. It shows owner/agent auth, the daily cap with reservation, an NEP-297 event, a method returning a `Promise` with a callback, and a `#[callback_result]` callback that never panics.

```rust
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, NearToken,
               PanicOnDefault, Promise, PromiseError};

pub const NS_PER_DAY: u64 = 86_400_000_000_000;
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(50);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FtCore {
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128,
                        memo: Option<String>, msg: String) -> U128;
}

#[near(event_json(standard = "trellis_vault"))]
pub enum VaultEvent {
    #[event_version("1.0.0")] ActionStarted { op_id: u64, amount: U128 },
    #[event_version("1.0.0")] ActionSettled { op_id: u64, used: U128 },
    #[event_version("1.0.0")] ActionFailed  { op_id: u64, reason: String },
}
// Emits: EVENT_JSON:{"standard":"trellis_vault","version":"1.0.0","event":"action_started","data":{"op_id":0,"amount":"40"}}
// NOTE: `data` is the variant object, not an array. If the spec requires `"data":[{..}]`,
// make the variant hold a Vec, or format the log yourself.

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MiniVault {
    owner: AccountId, agent: Option<AccountId>, token: AccountId, protocol: AccountId,
    daily_cap: u128, spent: LookupMap<u64, u128>, next_op_id: u64, in_flight: Option<u64>,
}

#[near]
impl MiniVault {
    #[init]
    pub fn new(owner: AccountId, token: AccountId, protocol: AccountId, daily_cap: U128) -> Self {
        Self { owner, agent: None, token, protocol, daily_cap: daily_cap.0,
               spent: LookupMap::new(b"s"), next_op_id: 0, in_flight: None }
    }

    #[payable]
    pub fn set_agent(&mut self, agent: Option<AccountId>) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
        self.agent = agent;
    }

    pub fn agent_supply(&mut self, amount: U128) -> Promise {
        require!(Some(env::predecessor_account_id()) == self.agent, "ERR_NOT_AGENT");
        require!(self.in_flight.is_none(), "ERR_LOCKED");
        let day = env::block_timestamp() / NS_PER_DAY;
        let spent = self.spent.get(&day).copied().unwrap_or(0);
        require!(spent + amount.0 <= self.daily_cap, "ERR_DAILY_CAP");
        self.spent.insert(day, spent + amount.0);              // reserve before the call
        let op_id = self.next_op_id; self.next_op_id += 1; self.in_flight = Some(op_id);
        VaultEvent::ActionStarted { op_id, amount }.emit();
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER_CALL)
            .ft_transfer_call(self.protocol.clone(), amount, None, String::new())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK)
                  .on_supply_done(op_id, day, amount))
    }

    #[private]
    pub fn on_supply_done(&mut self, op_id: u64, day: u64, amount: U128,
                          #[callback_result] used: Result<U128, PromiseError>) -> U128 {
        self.in_flight = None;
        let used = match used { Ok(u) => u.0.min(amount.0), Err(_) => 0 };
        let unused = amount.0 - used;
        if unused > 0 {
            let s = self.spent.get(&day).copied().unwrap_or(0);
            self.spent.insert(day, s.saturating_sub(unused));
        }
        if used == 0 { VaultEvent::ActionFailed { op_id, reason: "external_failed".into() }.emit(); }
        else { VaultEvent::ActionSettled { op_id, used: U128(used) }.emit(); }
        U128(used)
    }

    pub fn remaining_today(&self) -> U128 {
        let s = self.spent.get(&(env::block_timestamp() / NS_PER_DAY)).copied().unwrap_or(0);
        U128(self.daily_cap.saturating_sub(s))
    }
    pub fn is_locked(&self) -> bool { self.in_flight.is_some() }
}
```

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
    use std::collections::HashMap;

    fn owner() -> AccountId { "alice.near".parse().unwrap() }
    fn agent() -> AccountId { "agent.trellis.near".parse().unwrap() }
    fn stranger() -> AccountId { "mallory.near".parse().unwrap() }
    fn vault_id() -> AccountId { "alice-near.trellis.near".parse().unwrap() }
    fn token() -> AccountId { "wrap.near".parse().unwrap() }
    fn burrow() -> AccountId { "contract.main.burrow.near".parse().unwrap() }
    const DAY0: u64 = 1_792_627_200_000_000_000; // 2026-10-22T00:00:00Z (ns)
    const T: u64 = DAY0 + 3_600_000_000_000;     // 01:00 UTC

    fn ctx(pred: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(vault_id()).signer_account_id(pred.clone())
         .predecessor_account_id(pred).block_timestamp(T)
         .account_balance(NearToken::from_near(5));
        b
    }
    fn setup() -> MiniVault {
        testing_env!(ctx(owner()).build());
        let mut v = MiniVault::new(owner(), token(), burrow(), U128(100));
        testing_env!(ctx(owner()).attached_deposit(NearToken::from_yoctonear(1)).build());
        v.set_agent(Some(agent()));
        v
    }

    // --- panics: match the exact message from require!/assert_one_yocto
    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn owner_method_requires_one_yocto() {
        let mut v = setup();
        testing_env!(ctx(owner()).build());
        v.set_agent(None);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_AGENT")]
    fn owner_is_not_agent() {
        let mut v = setup();
        testing_env!(ctx(owner()).build());
        let _ = v.agent_supply(U128(1));
    }

    // --- Promise + event assertions
    #[test]
    fn agent_supply_schedules_ft_transfer_call_and_logs_event() {
        let mut v = setup();
        testing_env!(ctx(agent()).build());
        drop(v.agent_supply(U128(40)));             // receipts are created on drop

        let logs = get_logs();
        let ev: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(ev["event"], "action_started");
        assert_eq!(ev["data"]["amount"], "40");

        let r = get_created_receipts();
        assert_eq!(r.len(), 2);                      // ft_transfer_call + .then(callback)
        assert_eq!(r[0].receiver_id, token());
        match &r[0].actions[0] {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, .. } => {
                assert_eq!(method_name, b"ft_transfer_call");
                assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
                assert_eq!(*prepaid_gas, GAS_FT_TRANSFER_CALL);
                let a: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
                assert_eq!(a["receiver_id"], burrow().to_string());
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(r[1].receiver_id, vault_id());
        assert_eq!(v.remaining_today(), U128(60));   // reserved
        assert!(v.is_locked());
    }

    // --- callbacks: #[callback_result] params are ordinary fn args in unit tests
    #[test]
    fn callback_failure_releases_reservation() {
        let mut v = setup();
        testing_env!(ctx(agent()).build());
        let _ = v.agent_supply(U128(40));
        testing_env!(ctx(vault_id()).build(), near_sdk::test_vm_config(),
                     RuntimeFeesConfig::test(), HashMap::default(), vec![PromiseResult::Failed]);
        let used = v.on_supply_done(0, T / NS_PER_DAY, U128(40), Err(PromiseError::Failed));
        assert_eq!(used, U128(0));
        assert_eq!(v.remaining_today(), U128(100));
        assert!(!v.is_locked());
        assert!(get_logs()[0].contains("\"event\":\"action_failed\""));
    }

    // --- guards that unit tests can NOT see
    #[test]
    fn private_and_payable_are_not_checked_in_unit_tests() {
        let mut v = setup();
        testing_env!(ctx(stranger()).attached_deposit(NearToken::from_near(1)).build());
        assert_eq!(v.on_supply_done(0, 0, U128(1), Ok(U128(1))), U128(1)); // no panic!
    }

    // --- time travel: day rollover via block_timestamp
    #[test]
    fn day_rollover_resets_cap() {
        let mut v = setup();
        testing_env!(ctx(agent()).build());
        let _ = v.agent_supply(U128(100));
        testing_env!(ctx(vault_id()).build());
        v.on_supply_done(0, T / NS_PER_DAY, U128(100), Ok(U128(100)));
        testing_env!(ctx(agent()).block_timestamp(DAY0 + NS_PER_DAY - 1).build());
        assert_eq!(v.remaining_today(), U128(0));    // 23:59:59.999
        testing_env!(ctx(agent()).block_timestamp(DAY0 + NS_PER_DAY).build());
        assert_eq!(v.remaining_today(), U128(100));  // 00:00 next day; storage survived
        let _ = v.agent_supply(U128(100));
    }

    // --- several panics in one test (no #[should_panic])
    #[test]
    fn catch_panic_message() {
        let v = setup();
        testing_env!(ctx(stranger()).build());
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut v = v; let _ = v.agent_supply(U128(1));
        })).unwrap_err();
        let msg = err.downcast_ref::<String>().map(|s| s.as_str())
            .or_else(|| err.downcast_ref::<&str>().copied()).unwrap_or("");
        assert!(msg.contains("ERR_NOT_AGENT"));
    }
}
```

## Patterns for the vault test plan

- **Auth matrix:** write one helper per caller (owner, agent, stranger, the vault itself). For each `agent_*` method, assert `ERR_NOT_AGENT` for owner and stranger, and the paused and expired errors after `set_policy`/`pause`. Non-payable checks: sandbox only.
- **Agent expiry:** set `agent_expires_at = T + 10s` and move `block_timestamp` past it.
- **HF and min_out math:** keep them as pure functions (`fn health_factor_bps(positions, prices) -> u32`) and test them as plain Rust, without `testing_env!`. Use Burrow-known vectors from `rhea-burrow-lending`.
- **Callback branches:** call the callback directly with `Ok(..)` / `Err(PromiseError::Failed)` and the right `ctx(vault_id())`. If the code reads `env::promise_result(i)` manually, for example for `join` results, pass `vec![PromiseResult::Successful(serde_json::to_vec(&x).unwrap()), ...]` via the 5-arg `testing_env!`.
- **Log hygiene:** `get_logs()` returns logs since the last `testing_env!`, so reset the context before the call you want to inspect.
- **Storage costs:** `env::storage_usage()` works in unit tests, but storage staking isn't enforced. Check it in the sandbox.

## Sources (2026-10-22)

- near-sdk 5.29.1 `src/test_utils/{mod.rs,context.rs}`, `src/environment/mock/{receipt.rs,mocked_blockchain.rs}`, `src/promise.rs` (`impl Drop for Promise`): https://github.com/near/near-sdk-rs/tree/near-sdk-v5.29.1/near-sdk/src
- `#[near(event_json)]` docs: https://docs.rs/near-sdk/5.29.1/near_sdk/attr.near.html
- cargo-near 0.22 template unit tests (`new-project-template/src/lib.rs`): https://github.com/near/cargo-near
- The code above, as printed, was run locally: `cargo test` → 7 passed.

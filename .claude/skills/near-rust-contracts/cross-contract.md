# Cross-contract calls, callbacks, gas, failure model

Verified 2026-10-22: near-sdk 5.29.1 source (`promise.rs`, `#[near]` macro docs, `examples/callback-results`),
docs.near.org anatomy/crosscontract and security/cross-contract-calls pages, and the mainnet protocol config
(protocol version 86, via `EXPERIMENTAL_protocol_config`). Code compiled against near-sdk 5.29.1.

## 1. The model in five sentences
1. Calls are **async**: your method finishes and commits, then the call runs in a later block (1–2 blocks later), then the callback runs in another receipt.
2. Calls are **independent**: if the callee panics, **nothing in your contract rolls back**. Any NEAR you attached comes back to *your contract* (not the user).
3. Between your call and your callback, **any other method of your contract can run** (interleaving). That's NEAR's form of reentrancy.
4. A `.then()` callback **always runs** (it sees success or failure), but it **can itself fail** (out of gas, panic, bad deserialization). If it does, only the callback's own changes revert and it's never retried.
5. A batch of actions to the **same** receiver in one `Promise` is atomic (all or nothing). Promises to **different** receivers joined with `.and()` are not.

## 2. High-level API: `#[ext_contract]` and `Self::ext`

```rust
use near_sdk::json_types::U128;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue};

#[ext_contract(ext_ft)]                       // generates module `ext_ft` with `ext_ft::ext(account_id)`
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128,
                        memo: Option<String>, msg: String) -> PromiseOrValue<U128>;
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}
// Without a name, `#[ext_contract] pub trait ExtStatusMessage` → module `ext_status_message`.
// near-contract-standards already exports ext_ft_core, ext_ft_receiver, ext_storage_management, ext_ft_metadata.

const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(60);   // [VERIFY] with sandbox gas profiling
const GAS_CALLBACK: Gas = Gas::from_tgas(20);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near]
impl Vault {
    pub fn agent_supply(&mut self, token: AccountId, amount: U128, receiver: AccountId) -> Promise {
        // ... auth + reserve (see §6) ...
        let op_id = self.start_op(&token, amount);
        ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER_CALL)
            .ft_transfer_call(receiver, amount, None, String::new())
            .then(
                Self::ext(env::current_account_id())      // or Self::ext_self() (5.25+)
                    .with_static_gas(GAS_CALLBACK)
                    .with_unused_gas_weight(0)            // callback gets only its static gas
                    .on_supply_done(op_id, String::from("reason-hash")),
            )
    }

    #[private]
    pub fn on_supply_done(
        &mut self,
        op_id: u64,                                       // normal args first (JSON)
        reason_hash: String,
        #[callback_result] used: Result<U128, PromiseError>,   // promise result(s) after
    ) -> U128 {
        // never panic here: see §7
        U128(0)
    }
}
```

Builder methods on every `*Ext`: `.with_attached_deposit(NearToken)`, `.with_static_gas(Gas)`,
`.with_unused_gas_weight(u64)`. `Contract::ext_on(promise)` adds a function call **to an existing
promise's batch** (5.18+).

**`Promise` is `#[must_use]`.** Either return it from the method (its result becomes the method's
result) or call `.detach()` to fire-and-forget. Dropping it still schedules it, but you get a warning.
Detaching is explicit since 5.18.

## 3. Low-level API: `Promise::new`

```rust
Promise::new(token.clone())
    .function_call("ft_transfer".to_string(),
        near_sdk::serde_json::json!({"receiver_id": owner, "amount": amount}).to_string().into_bytes(),
        ONE_YOCTO, Gas::from_tgas(10))
    .then(Self::ext_self().with_static_gas(GAS_CALLBACK).on_done(op_id))
```
Available actions on a single-receiver `Promise` (all in one atomic batch): `create_account`, `transfer`,
`deploy_contract`, `deploy_global_contract`, `deploy_global_contract_by_account_id`, `use_global_contract`,
`use_global_contract_by_account_id`, `function_call`, `function_call_weight(…, GasWeight)`, `stake`,
`add_full_access_key`, `add_access_key_allowance`, `delete_key`, `delete_account`,
gas-key actions (`add_gas_key_*`, `transfer_to_gas_key`), plus `refund_to` / `state_init` behind the
`deterministic-account-ids` feature. Deprecated: `add_access_key` (use `add_access_key_allowance`).
`Promise::function_call` uses fixed gas (no weight); `function_call_weight` adds a share of unused gas.

## 4. Composing promises

| Pattern | Valid? |
|---|---|
| `p1.then(p2).then(p3)` | ✅ chain; each step gets the previous result |
| `p1.and(p2).then(cb)` | ✅ parallel, `cb` sees **both** results (index 0 = p1, 1 = p2) |
| `return p1.and(p2)` (no `.then`) | ⛔ invalid: a joint promise must be followed by `.then` |
| `p1.then(p2.and(p3))` / `p1.then(p2.then(p3))` | ⛔ invalid: no join or nested `then` inside a `then` |
| `p1.then_concurrent([p2, p3]).join().then(p4)` | ✅ fan-out after p1, then fan-in (5.16+) |
| batch on the same receiver | atomic. The callback only sees the **last** function call's result |

Reading multiple results (joined promises map to `#[callback_result]` args in order):
```rust
pub fn sync_two(&mut self, a: AccountId, b: AccountId) -> Promise {
    let me = env::current_account_id();
    ext_ft::ext(a).with_static_gas(Gas::from_tgas(5)).ft_balance_of(me.clone())
        .and(ext_ft::ext(b).with_static_gas(Gas::from_tgas(5)).ft_balance_of(me))
        .then(Self::ext_self().with_static_gas(GAS_CALLBACK).on_sync_two())
}

#[private]
pub fn on_sync_two(
    &mut self,
    #[callback_result] a: Result<U128, PromiseError>,     // result index 0
    #[callback_result] b: Result<U128, PromiseError>,     // result index 1
) -> Option<(U128, U128)> {
    match (a, b) { (Ok(a), Ok(b)) => Some((a, b)), _ => None }
}
```
- `#[callback_vec] results: Vec<T>` collects N homogeneous results but **panics if any failed**.
- `#[callback_result(max_bytes = 100)]` bounds how many bytes are read (protects callback gas).

### `#[callback_result]` vs `#[callback_unwrap]`
| | callee failed | callee returned bytes that don't deserialize to `T` |
|---|---|---|
| `#[callback_unwrap] x: T` | **panics** | panics |
| `#[callback_result] x: Result<T, PromiseError>` | `Err(PromiseError::Failed)` | **still panics** (generated code) |
| manual `env::promise_result_checked(i, max_len)` | `Err(Failed)` | you decide (`serde_json::from_slice` → handle `Err`) |

For a vault, use `#[callback_result]` everywhere. For **untrusted or complex external return types**
(e.g. a protocol's position struct that might change shape), read raw bytes so a schema mismatch can't panic the callback:
```rust
#[private]
pub fn on_positions(&mut self, op_id: u64) -> bool {
    if env::promise_results_count() != 1 { self.fail(op_id, "bad_results"); return false; }
    match env::promise_result_checked(0, 16 * 1024) {
        Ok(bytes) => match near_sdk::serde_json::from_slice::<Positions>(&bytes) {
            Ok(p) => { self.settle(op_id, p); true }
            Err(_) => { self.fail(op_id, "decode"); false }
        },
        Err(_) => { self.fail(op_id, "external_failed"); false }   // Failed or TooLong
    }
}
```
`env::promise_result` (unbounded) is **deprecated** in 5.24+. Use `promise_result_checked`.

## 5. Gas budgeting (current limits, verified on mainnet protocol config 2026-10-22)
- **Max prepaid gas per transaction: 1,000 Tgas (1 PGas)** (`max_total_prepaid_gas`), and max gas burnt per receipt is also 1 PGas.
  It used to be 300 Tgas. Older docs/examples and the CLI's `300.0 Tgas` habits are stale. The near-sdk 5.26+ defaults assume 1 PGas.
- 1 Tgas ≈ 1 ms compute. Gas price floor 0.0001 NEAR/Tgas, so a full 1 PGas tx burns ≤ 0.1 NEAR.
- Static vs weight: each promise gets `static_gas` plus a share of the **unused** gas proportional to its
  `unused_gas_weight` (**default weight = 1**). The share is computed at the end of your method.
  Callbacks that should get a fixed amount need `.with_unused_gas_weight(0)`. Otherwise the callback silently
  receives a large share, and the external call may starve.
- Budget = this method's own execution + Σ static gas of every promise it creates + the gas those promises
  forward further (e.g. `ft_transfer_call` forwards to `ft_on_transfer` and keeps ~5 Tgas for `ft_resolve_transfer`).
- Don't attach far more gas than needed: congestion control treats attached gas as an upper bound of work,
  and a future gas-refund fee (`max(1 Tgas, 5% of unspent)`, currently 0) will charge for unspent gas.
- Measure every chain in sandbox (`near-contract-testing`), then set constants with a ~30% margin.
  Check `env::prepaid_gas()` at entry and fail early with a clear message if the caller attached too little.

```rust
const GAS_RESERVED_FOR_CALLBACK: Gas = Gas::from_tgas(25);
require!(env::prepaid_gas() >= Gas::from_tgas(150), "Attach at least 150 Tgas");
```

## 6. Reserve-before / settle-after (the core pattern)
State that guards funds must be correct **at the end of every receipt**, including while a call is pending.

```text
method (receipt 1):  checks → reserve/debit (caps, balances) → set lock {op_id, Started→Submitted}
                     → schedule call.then(callback(op_id))
external (receipt 2): may succeed, partially succeed, or fail
callback (receipt 3): read result → keep reservation for what was actually used,
                      release the rest → emit event → clear lock. Never panic.
```
```rust
#[private]
pub fn on_supply_done(&mut self, op_id: u64, reason_hash: String,
                      #[callback_result] used: Result<U128, PromiseError>) -> U128 {
    let Some(op) = self.in_flight.take() else { return U128(0) };     // no panic on surprise
    if op.op_id != op_id { self.in_flight = Some(op); return U128(0); }
    let used = used.map(|u| u.0).unwrap_or(0);                      // failure → 0 used
    let unused = op.amount.0.saturating_sub(used);
    if unused > 0 {                                                 // release the unused reservation
        let key = (op.token.clone(), op.started_at.0 / 86_400_000_000_000);
        if let Some(s) = self.spent.get_mut(&key) { *s = s.saturating_sub(unused); }
    }
    // emit action_settled / action_failed (events-and-factory.md)
    U128(used)
}
```
Rules:
- **Debit/lock before the call, credit only in the callback after success.** Never credit "expected" output up front.
- **One in-flight op lock** (`Option<PendingOp>`) for agent actions. Every agent method checks `in_flight.is_none()`.
  Owner escape hatches (withdraw, pause, `clear_stale_lock` after a timeout) must not depend on the lock.
- Store everything the callback needs (op id, token, amount, day index, balance snapshot) **in state** or
  pass it as callback args. Don't recompute "today" in the callback: the day may have rolled over.
- Settle from **actual balances** (`ft_balance_of`, protocol views) when the callee's return value is
  not trustworthy or not returned at all (e.g. fire-and-forget inner promises).
- Callers that need the final result should receive the returned `Promise` (return it, don't detach).

## 7. Never-panic callbacks checklist
- `#[private]` on every callback (a public callback lets anyone forge "success").
- Use `#[callback_result]` or manual `promise_result_checked`. No `unwrap()`/`expect()`/`require!` in failure paths.
- Bounded work: no loops over user-sized collections, bounded result size (`max_bytes`), ≤100 logs / 16 KiB.
- Use saturating/checked math that falls back to a safe state (with `overflow-checks = true`, plain `+` overflow panics).
- Commit cleanup first (clear the lock, release the reservation), then schedule refunds.
- A failed call's attached NEAR is back in **your** contract by the time the callback runs. Refund the user explicitly if needed.
- If the callback can't be made infallible, give the owner a recovery path (`clear_stale_lock`, `sync_position`).
- The callback runs against the code deployed **when it executes**. Don't rename or remove callbacks in an upgrade while ops are in flight.

## 8. `PromiseOrValue<T>`
Return either an immediate value or a promise whose result becomes the return value:
```rust
pub fn maybe_call(&self, token: AccountId, local: bool) -> PromiseOrValue<U128> {
    if local { PromiseOrValue::Value(U128(0)) }
    else { ext_ft::ext(token).with_static_gas(Gas::from_tgas(5))
             .ft_balance_of(env::current_account_id()).into() }
}
```
`ft_on_transfer` must return `PromiseOrValue<U128>` (see `tokens.md`).

## 9. Yield / resume (FYI)
`Promise::new_yield(fn_name, args, gas, GasWeight)` returns `(Promise, YieldId)`. Another transaction can
`yield_id.resume(data)` within `yield_timeout_length_in_blocks` (200 on mainnet) before the callback runs with
a timeout error. Useful for "wait for an off-chain signer" flows. We don't use it in the vault.

# Security: auth, access keys, gas keys, interleaving, math, storage, pause, upgrades, global contracts

Verified 2026-10-22: near-sdk 5.29.1 source (`promise.rs`, `Allowance`, macro docs), docs.near.org
(access-keys, one_yocto, security checklist, callbacks pages, upgrade, global-contracts, storage-staking),
mainnet RPC (protocol version 86, nearcore 2.13.4). Code compiled against near-sdk 5.29.1.

## 1. Who is calling? (auth)
- Authorize with **`env::predecessor_account_id()`** (the immediate caller). Use `signer_account_id()` only if
  the rule really is about the original transaction signer. A contract in the middle changes the predecessor, not the signer.
- **Owner methods: predecessor check + `assert_one_yocto()`** (the method must be `#[payable]`).
  Function-call keys **can't attach any deposit**, so 1 yocto proves the call was signed with a full-access key,
  i.e. wallet-confirmed. That stops a dapp FC key from calling owner methods.
```rust
#[payable]
pub fn withdraw_ft(&mut self, token: AccountId, amount: U128) -> Promise {
    near_sdk::assert_one_yocto();                                   // panics: "Requires attached deposit of exactly 1 yoctoNEAR"
    require!(env::predecessor_account_id() == self.owner, "Only owner");
    ext_ft_core::ext(token).with_attached_deposit(NearToken::from_yoctonear(1))
        .with_static_gas(Gas::from_tgas(10))
        .ft_transfer(self.owner.clone(), amount, None)              // recipient is never a parameter
}
```
- **Agent methods: non-payable** (default; any deposit panics) + `predecessor == policy.agent` + not paused + not expired.
- **Callbacks: `#[private]`** (= `predecessor == current_account_id`). Caveat: if anyone holds an access key **on the
  contract account itself**, their transactions also have `predecessor == current_account_id` and pass `#[private]`.
  So keep the agent key on a **separate account** and give the vault **no keys** (locked account, controlled only by code).
- `#[init]` methods must be called in the same batch as the deploy (factory does Deploy+FunctionCall `new`),
  otherwise anyone can front-run initialization with themselves as owner. Optionally make `new` `#[private]`
  (allowed since 5.18) when the account initializes itself.

## 2. Function-call access keys (protocol rules)
A key is either **FullAccess** or **FunctionCall { receiver_id, method_names, allowance }**:
- `receiver_id`: the **only** contract it can call.
- `method_names`: allowed methods. **Empty = all methods** of `receiver_id`. Protocol limit: 2000 bytes total
  (`max_number_bytes_method_names`).
- `allowance`: NEAR the key may spend on **gas**, charged at the higher *buy* price and credited back on refund.
  `None`/0 = unlimited. When a limited allowance runs out, the key stops working.
- **No deposits at all**, not even 1 yocto, so FC keys can't call `ft_transfer`, `near_withdraw`, owner methods, or anything `#[payable]` that asserts a deposit.
- An FC key can only sign `FunctionCall` actions to that receiver. No transfers, key management or deploys.
- An account with only FC keys can't move NEAR or manage keys unless its contract exposes methods for it.

### Adding / deleting keys **from a contract** (only on its own account, or an account created in the same batch)
```rust
use near_sdk::{Allowance, PublicKey};
// add FC key on THIS contract's account
Promise::new(env::current_account_id()).add_access_key_allowance(
    public_key,                                              // PublicKey, JSON "ed25519:..."
    Allowance::limited(NearToken::from_millinear(250)).unwrap(), // Option: None if zero → use Allowance::unlimited()
    receiver_id,                                             // contract the key may call
    "agent_supply,agent_repay,sync_position",                // comma-separated, "" = any method
)
// delete
Promise::new(env::current_account_id()).delete_key(public_key)
// full access (avoid in a vault)
Promise::new(account).add_full_access_key(public_key)
```
- `Promise::add_access_key` / `add_access_key_with_nonce` (taking `NearToken` allowance) are **deprecated since 5.0**.
- In our design the agent's FC keys live on the **agent account** and are added with the CLI from the agent account's
  full-access key (`cli.md` §3), not by the vault. Revocation = owner calls `revoke_agent` on the vault (instant), plus
  optionally deleting the key from the agent account.

## 3. Gas keys (NEP-611): live on mainnet
Introduced in nearcore 2.13 / protocol version 86. Mainnet reports protocol 86 on 2026-10-22, so they're **live**.
- A gas key holds its **own prepaid NEAR balance** for gas, plus up to **1,024 parallel nonce lanes** (`nonce_index` per tx).
  It fits an agent worker sending many transactions concurrently.
- Permission can be FullAccess or FunctionCall. Docs say a **function-call gas key cannot set an `allowance`**
  (its balance is the budget).
- Lifecycle: AddKey (gas-key permission, `num_nonces` 1..=1024, starts at 0 balance) → `TransferToGasKey` (fund) →
  use → `WithdrawFromGasKey` (only the account itself) → `DeleteKey`. **Deleting burns the remaining balance**, and
  the delete fails if more than 1 NEAR would be burned.
- Gas is paid from the key's balance. **Attached deposits still come from the account balance.**
- near-sdk 5.29 actions: `Promise::add_gas_key_full_access(pk, num_nonces)`,
  `add_gas_key_allowance_function_call(pk, num_nonces, allowance: Allowance, receiver_id, function_names: String)`,
  `transfer_to_gas_key(pk, amount)`. The SDK signature takes an `Allowance` despite the docs' "no allowance" rule.
  Pass `Allowance::unlimited()`. **[VERIFY]** in sandbox before relying on it.
- CLI: `near account add-key <acct> grant-gas-key-full-access --num-nonces 8 ...`, `fund-gas-key`, `withdraw-from-gas-key`,
  `view-gas-key-nonces`, and `--nonce-index N` when signing. The CLI form for a **function-call** gas key is **[VERIFY]**
  (docs only show full access). Stretch goal only. A plain FC key per vault works fine for the hackathon.

## 4. Interleaving ("reentrancy") on NEAR
There's no synchronous reentrancy, but **between a call and its callback any public method can run**, including
the same method again and other users' calls.
- Debit/reserve **before** scheduling the call. Restore only in the callback on failure.
- Hold a **single in-flight lock** for multi-step operations. Reject a second agent op while locked.
- Never read "pending" balances as available. Keep reserved amounts out of cap/balance checks.
- Store the op context in state (op id, amounts, day index) and match `op_id` in the callback.
- Give the owner a timeout escape (`clear_stale_lock`) that only releases reservations proven unspent.
Details and code: `cross-contract.md` §6–7.

## 5. Integer safety
- Keep `overflow-checks = true` in `[profile.release]` (cargo-near template default). Overflow then **panics**
  instead of wrapping, which is safe for normal methods but aborts a callback (see never-panic rules).
- Prefer explicit `checked_add/checked_mul/checked_sub` with an explicit error, or `saturating_*` in callbacks.
- Use `u128` for token amounts. For price × amount intermediates use a wider type (e.g. the `uint` crate's `U256`,
  or `primitive-types`) [VERIFY dependency compiles under cargo-near], then convert back with a checked `try_into()`.
- Order of operations: multiply before divide, round **down** amounts paid out and **up** amounts required.
- `NearToken` has `checked_add/checked_sub/saturating_*`. Don't do math on `.as_yoctonear()` without checks.

## 6. Storage staking
- Every byte of contract state locks 10^19 yocto (1 NEAR / 100 kB) from the **contract's own balance**.
  If the balance drops below the locked amount, the receipt fails ("LackBalanceForState").
- An account can use up to **770 bytes** without staking (zero-balance accounts). A vault will exceed this.
- Whoever causes state growth should pay for it: measure `env::storage_usage()` before/after and require/charge
  `delta × env::storage_byte_cost()` from the attached deposit, or bound growth (fixed-size ring buffer for receipts).
- Never let unauthenticated callers add unbounded entries (storage-griefing attack).
- Keep a NEAR reserve (`min_near_reserve`) that agent actions can't spend: storage + 1-yocto calls + storage deposits.
- Wasm code itself costs storage if deployed directly (~3–5 NEAR for a 300–500 kB contract). With a global contract,
  the account only stores a small reference.

## 7. Pausing
```rust
#[payable] pub fn pause(&mut self)   { assert_one_yocto(); self.assert_owner(); self.paused = true;  /* emit */ }
#[payable] pub fn unpause(&mut self) { assert_one_yocto(); self.assert_owner(); self.paused = false; /* emit */ }
fn assert_agent(&self) { require!(!self.paused, "Paused"); /* ...agent checks... */ }
```
Pause blocks **agent** entry points only. Owner withdrawals, callbacks and `sync_position` must keep working while
paused, or funds can get stuck mid-operation.

## 8. Upgrades and state migration
State (`STATE` key + collection prefixes) survives a code change. If the struct layout changes, the next call fails with
`Cannot deserialize the contract state` until you migrate.

```rust
#[payable]
pub fn upgrade_with_code(&mut self) -> Promise {          // wasm passed as raw input (CLI: file-args)
    near_sdk::assert_one_yocto();
    self.assert_owner();
    let code = env::input().unwrap_or_else(|| env::panic_str("no code"));
    Promise::new(env::current_account_id())
        .deploy_contract(code)
        .function_call_weight("migrate".to_string(), Vec::new(),
            NearToken::from_yoctonear(0), Gas::from_tgas(20), near_sdk::GasWeight(1))
}

#[private]
#[init(ignore_state)]                                     // re-init over existing state
pub fn migrate() -> Self {
    let old: OldVault = env::state_read().unwrap_or_else(|| env::panic_str("no state"));
    Self { owner: old.owner, /* map old → new fields, new collections get NEW prefixes */ }
}
```
- Deploy + `migrate` in **one batch** (same receipt), so no call can hit the new code with old state in between.
- Clean up removed collections explicitly (their keys stay in storage and keep costing stake).
- Alternative: versioned state enum (`#[near(contract_state)] pub enum VersionedContract { V0(..), V1(..) }`),
  lazily upgraded on access. See near-sdk `examples/versioned`.
- Don't remove or rename callback methods while operations are in flight. Pending callbacks run against the new code.

## 9. Global contracts (NEP-591): live, supported in near-sdk since 5.17
- Deploy the code once globally. Accounts then **reference** it, storing only a small id instead of the full wasm.
- Global deploy cost: **10× normal storage price, burned** (10 NEAR per 100 kB, non-refundable).
  Using a global contract costs only the reference bytes (< 0.001 NEAR typical).
- Two reference modes:
  | Mode | Deploy (SDK `Promise`) | Use (SDK `Promise`) | Upgrades |
  |---|---|---|---|
  | **By code hash** (immutable) | `.deploy_global_contract(code)` | `.use_global_contract(code_hash)` (`impl Into<CryptoHash>`, e.g. `Base58CryptoHash`) | account switches only by explicitly using a new hash |
  | **By account id** (mutable) | `.deploy_global_contract_by_account_id(code)` (identified by the deploying account) | `.use_global_contract_by_account_id(deployer_id)` | deployer redeploys → **every** referencing account runs the new code automatically |
- CLI: `near contract deploy-as-global use-file <wasm> as-global-hash <acct> ...` /
  `... as-global-account-id <acct> ...`. Use: `near contract deploy <acct> use-global-hash <hash> without-init-call ...`
  (see `cli.md`).
- `env::current_contract_code()` → `AccountContract::{None, Local(h), Global(h), GlobalByAccount(id)}`.
  `env::current_global_contract_id()` also exists (5.24+).
- **Trust choice for the vault:** by-account-id lets the deployer (us) upgrade every user's vault at once. That
  breaks "factory has no rights over vaults". Use **by code hash**, and let only the owner switch versions:
```rust
#[payable]
pub fn upgrade(&mut self, code_hash: near_sdk::json_types::Base58CryptoHash) -> Promise {
    near_sdk::assert_one_yocto();
    self.assert_owner();
    Promise::new(env::current_account_id())
        .use_global_contract(code_hash)                    // UseGlobalContract action on itself
        .function_call("migrate".to_string(), Vec::new(), NearToken::from_yoctonear(0), Gas::from_tgas(50))
}
```
  This compiles against 5.29.1. A contract running `UseGlobalContract` on its **own** account plus `migrate` in the
  same batch is **[VERIFY in sandbox]** (docs only show CLI/factory usage).
- Factory flow (create subaccount + `use_global_contract` + init) is in `events-and-factory.md`.
- Sandbox/testing support for global contracts → `near-contract-testing` skill.

## 10. Quick review checklist
- [ ] Every `pub fn` in `#[near]` impls is meant to be public. Helpers are non-`pub` or in a plain impl.
- [ ] Owner methods: `#[payable]` + `assert_one_yocto()` + predecessor check. Funds go to `owner` only.
- [ ] Agent methods: non-payable, predecessor == agent, not paused/expired, caps checked, no free-form recipient/msg.
- [ ] Callbacks: `#[private]`, `#[callback_result]`, never panic, bounded gas, clear the lock.
- [ ] `ft_on_transfer` checks predecessor against the token allowlist.
- [ ] Unique storage prefixes. Bounded collections. Storage paid by whoever causes growth.
- [ ] `overflow-checks = true`. Checked math on all amounts.
- [ ] Vault account has **no access keys**. Upgrades only through an owner method.
- [ ] Hardcode protocol account ids (feature-flagged per network). Don't take them from the agent.

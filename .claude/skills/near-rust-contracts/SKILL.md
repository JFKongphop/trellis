---
name: near-rust-contracts
description: >
  Writing, reviewing and deploying NEAR smart contracts in Rust with near-sdk 5.29.x and cargo-near 0.22:
  #[near]/#[near(contract_state)] macros, #[init]/#[payable]/#[private], store collections and storage keys,
  U128/NearToken/Gas types, env functions, cross-contract calls (Promise, #[ext_contract], ext()/ext_self(),
  .then()/.and() callbacks, #[callback_result], PromiseOrValue, gas budgeting under the 1 PGas tx limit),
  NEP-141 ft_transfer/ft_transfer_call/ft_on_transfer, NEP-145 storage_deposit, wrap.near, assert_one_yocto,
  function-call access keys and NEP-611 gas keys, upgrades/migrate, NEP-591 global contracts, NEP-297 events,
  factory/subaccount deployment, near-cli-rs and raw RPC. Use whenever touching Rust contract code for
  Trellis (the policy vault or its factory), or when you see near-sdk, cross-contract, callback,
  Promise, NEP-141, storage_deposit, access key, cargo-near, deploy, global contract, or EVENT_JSON.
---

# NEAR Rust contracts (near-sdk 5.29.1)

Generic, verified NEAR contract knowledge for the Trellis policy vault and factory. Project rules and the vault
design live in the `trellis-vault` skill (and `docs/vault-spec.md`). Protocol-specific integrations live in
`rhea-burrow-lending`, `ref-dex-swaps` and `near-intents`. Sandbox/unit testing is in `near-contract-testing`,
frontend in `near-frontend`, the agent worker in `near-ai-agent-infra`.

Pinned versions (crates.io, 2026-10-22): **near-sdk 5.29.1**, near-contract-standards 5.29.1, **cargo-near 0.22.0**,
near-cli-rs 0.30.1, near-workspaces 0.23.0. Rust ≥ 1.93, edition 2024. Mainnet is on protocol 86 (nearcore 2.13).
Code in the reference files was compiled and unit-tested against near-sdk 5.29.1.

## Mistakes AI agents commonly make on NEAR (check every diff against these)
1. **Treating cross-contract calls as atomic.** They're async and independent. If the callee fails, your state
   does **not** roll back. Reserve/debit before the call, settle in the callback, and assume other methods run in between.
2. **Callbacks that panic or aren't `#[private]`.** A panicking callback reverts its own cleanup and never refunds.
   Use `#[callback_result]` (not `#[callback_unwrap]`), and no `unwrap`/`require!` on failure paths.
   `#[callback_result]` **still panics if the bytes don't deserialize**. Read untrusted shapes with `env::promise_result_checked`.
3. **Wrong deposit on token calls.** `ft_transfer`, `ft_transfer_call`, `near_withdraw` and `storage_withdraw` need
   **exactly 1 yoctoNEAR**. Function-call access keys **can't attach any deposit**, so agents can't move tokens directly.
4. **Not authenticating `ft_on_transfer`.** The token is `env::predecessor_account_id()`. `sender_id`/`amount` are claims.
   Return the **unused** amount (`amount` = refund all).
5. **Missing NEP-145 registration.** Transfers to an account not registered on the token panic. Register the vault
   **and the owner** (`storage_deposit`, currently 0.00125 NEAR on wrap/USDT/USDC) before moving tokens.
6. **Stale gas numbers.** The per-transaction max is now **1000 Tgas** (not 300). The default `unused_gas_weight` is 1,
   so a callback without `.with_unused_gas_weight(0)` grabs a share of leftover gas.
7. **Raw `u128`/`u64` in JSON** (args, returns, event payloads). Use `json_types::U128`/`U64` (strings).
   `NearToken` and `Gas` already serialize as strings.
8. **Old SDK idioms.** `near_bindgen` (use `#[near]`), `near_sdk::collections::UnorderedMap` (use `store::IterableMap`),
   `Balance`/`u128` deposits (use `NearToken`), `Promise::add_access_key` (use `add_access_key_allowance`),
   `env::promise_result` (deprecated → `promise_result_checked`), building with plain `cargo build`
   (near-sdk ≥ 5.27 needs `--cfg near`, so **always `cargo near build`**).
9. **Dropping a `Promise`.** It's `#[must_use]`: return it (caller sees its result) or `.detach()` it explicitly.
   `p1.and(p2)` can't be returned without a `.then(...)`.
10. **Storage bugs.** Duplicate collection prefixes (silent corruption), unbounded `Vec`/`HashMap` in the root state struct,
    and forgetting that state growth locks the contract's own NEAR (10^19 yocto/byte).
11. **Auth with `signer_account_id`.** Use `predecessor_account_id`. Owner methods = predecessor check +
    `#[payable]` + `assert_one_yocto()`. Never put an access key on the vault account (it defeats `#[private]`).
12. **Upgrading without migrating.** A changed state struct needs `#[init(ignore_state)] migrate` in the **same batch**
    as the deploy. Global contracts *by account id* let the deployer silently upgrade every user's vault.
13. **Inventing APIs.** If a method isn't in the reference files or docs.rs, check the near-sdk source before using it.
    Mark unverified items `[VERIFY]`.

## Reference files
| File | Load when | Covers |
|---|---|---|
| `basics.md` | starting a crate, writing state/methods/views, choosing types or collections | cargo-near install/new/check/build/deploy, Cargo.toml + reproducible build, `#[near]` macro family, `PanicOnDefault`, `store::{LookupMap, IterableMap, Vector,…}` + `BorshStorageKey` prefixes, `AccountId`/`NearToken`/`Gas`/`U128`, full `env::*` table, `log!`/`require!` |
| `cross-contract.md` | any call to another contract or callback | async/independent model, `#[ext_contract]`, `ext()/ext_self()/ext_on()`, low-level `Promise` actions, `.then/.and/then_concurrent`, `#[callback_result]` vs `#[callback_unwrap]` vs manual results, gas limits and weights, reserve-before/settle-after with a lock, never-panic checklist, `PromiseOrValue`, yield/resume |
| `tokens.md` | moving or receiving NEP-141 tokens, registering storage, wrapping NEAR | `ft_transfer`/`ft_transfer_call` (1 yocto) and the resolve/refund sequence, `ft_on_transfer` receiver, `ft_balance_of`/`ft_metadata`, NEP-145 `storage_*`, `wrap.near` `near_deposit`/`near_withdraw`, implicit accounts |
| `security.md` | owner/agent auth, access keys, pausing, upgrades, math, storage | `assert_one_yocto` + owner checks, `#[private]` caveat, FC key rules, `add_access_key_allowance`/`delete_key` from a contract, NEP-611 gas keys, interleaving, overflow, storage staking, pause, deploy+`migrate`, NEP-591 global contracts (hash vs account), review checklist |
| `events-and-factory.md` | emitting receipts/events, writing the vault factory | NEP-297 format and `#[near(event_json)]` with verified output, account-id rules, subaccount naming (+ collision caveat), one-batch CreateAccount+Transfer+UseGlobalContract+FunctionCall with refund callback |
| `cli.md` | creating accounts, deploying, calling, managing keys, debugging via RPC | near-cli-rs commands (faucet account, deploy with init, global deploy, view/call with gas+deposit, FC keys, gas keys, delete keys, send NEAR/FT, tx status) and raw JSON-RPC against FastNEAR |

## Open [VERIFY] items (check in sandbox before relying on them)
- A contract running `use_global_contract(hash)` + `migrate` on **its own** account in one batch (compiles; untested on chain).
- `add_gas_key_allowance_function_call` takes an `Allowance` although docs say FC gas keys can't have one. CLI syntax for FC gas keys.
- Gas constants for `ft_transfer_call` chains, `new` in the factory, and callbacks (measure + 30%).
- Whether `near contract deploy ... use-global-hash` accepts `with-init-call`.
- Whether a failed receipt's outcome still carries pre-panic logs (trust events only from successful receipts).
- Exact signed bytes for any off-chain signature you `ed25519_verify` (e.g. 1Click quotes → `near-intents`).

## Sources (verified 2026-10-22)
- near-sdk-rs, tag `near-sdk-v5.29.1` (CHANGELOG, `near-sdk/src/{lib.rs,promise.rs,environment/env.rs,store/}`,
  `examples/{callback-results,cross-contract-calls,factory-contract,factory-contract-global,versioned}`, `tests/event_tests.rs`):
  https://github.com/near/near-sdk-rs
- near-contract-standards 5.29.1 (FT core/receiver/resolver, storage_management): same repo; https://docs.rs/near-contract-standards
- docs.rs: https://docs.rs/near-sdk/5.29.1/near_sdk/
- crates.io versions: https://crates.io/crates/near-sdk, https://crates.io/crates/cargo-near, https://crates.io/crates/near-cli-rs
- cargo-near README + `cargo near new` template: https://github.com/near/cargo-near
- docs.near.org (index https://docs.near.org/llms.txt): anatomy/crosscontract, anatomy/events, global-contracts,
  release/upgrade, release/deploy, protocol/accounts-contracts/{access-keys,account-id}, protocol/transactions/gas,
  protocol/storage/storage-staking, security/{checklist,one_yocto,cross-contract-calls/*}, tools/cli, api/rpc/{providers,contracts,transactions},
  tutorials/factories/factory
- near-cli-rs guide: https://github.com/near/near-cli-rs/blob/main/docs/GUIDE.en.md
- NEP-297 events: https://github.com/near/NEPs/blob/master/neps/nep-0297.md; NEP-591 global contracts:
  https://github.com/near/NEPs/blob/master/neps/nep-0591.md; NEP-611 gas keys: https://github.com/near/NEPs/pull/611
- Nomicon account ids: https://nomicon.io/DataStructures/Account
- near-examples factory (global contract, near-sdk 5.29.1): https://github.com/near-examples/factory-rust
- wrap.near source: https://github.com/near/core-contracts/tree/master/w-near
- Live mainnet/testnet checks: `status` + `EXPERIMENTAL_protocol_config` + `call_function` on https://free.rpc.fastnear.com and https://test.rpc.fastnear.com

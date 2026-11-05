---
name: near-contract-testing
description: How to test NEAR Rust smart contracts for the Trellis policy vault. Covers near-sdk unit tests (testing_env!, VMContextBuilder, get_logs, get_created_receipts, mocking callback results, time travel for daily caps), near-workspaces sandbox integration tests (sandbox(), dev_deploy, calls with deposit/gas, logs, receipt failures, fast_forward, gas profiling per receipt), importing mainnet contracts into the sandbox with import_contract (wrap.near, Ref v2, Burrow, mock USDC, mock Pyth oracle at aggregate-oracle.near), and testnet plus small-amount mainnet smoke tests. Use it when writing or debugging any NEAR contract test, integration test, sandbox, testing_env!, VMContextBuilder, import_contract, patch_state, or gas profiling.
---

# NEAR contract testing (Trellis vault)

Use this skill to test the per-user policy vault (`docs/vault-spec.md` §11) at three levels:

1. **Unit tests**: `near-sdk` mocked blockchain. They run in milliseconds and cover policy math, caps, day rollover, auth checks written in the method body, events, and the receipts a method schedules.
2. **Sandbox integration**: `near-workspaces` runs a real local `neard`. It covers cross-contract flows, `#[private]` and payable guards, callbacks, real Ref/Burrow/wrap wasm imported from mainnet, and gas.
3. **Live networks**: testnet barely helps for our stack. Smoke-test on mainnet with small amounts from dedicated accounts.

Related skills, kept separate so nothing is duplicated:
- `near-rust-contracts`: writing the contract.
- `rhea-burrow-lending`: Burrow message shapes, health-factor math, oracle.
- `ref-dex-swaps`: Ref swap semantics.
- `near-intents`: Intents.
- `near-ai-agent-infra`: worker and agent keys.
- `near-frontend`: the UI.

## Pinned versions (crates.io, checked 2026-10-22)

| Crate / tool | Use | Note |
|---|---|---|
| `near-sdk` | `5.29.1`, with `features = ["unit-testing"]` in dev-deps | 5.30.0-rc.1 exists. Don't use it. |
| `near-workspaces` | `0.23.0` (dev-dep only, it doesn't compile to wasm) | 0.24.0-rc.2 exists. 0.23 uses nearcore 0.37 crates and `near-sandbox 0.3.x`. |
| `cargo-near` CLI | `0.22.0` | Needed by `cargo_near_build::build_with_cli` / `near_workspaces::compile_project`. |
| `near-sandbox` (crate) | pulled in by workspaces (`^0.3.12`) | Downloads the `neard` sandbox binary at build time. Needs macOS ARM64 or Linux x86 and network on first build. |

The `cargo near new` template in cargo-near 0.22 now writes its integration tests with **`near-sandbox` + `near-api`** instead of near-workspaces, and docs.near.org follows it. Both stacks work. We use **near-workspaces 0.23**: it has `import_contract`, `patch`, typed `ExecutionFinalResult` with per-receipt outcomes, and `GasMeter`, and the Ref/Burrow recipes here were run with it.

## Common mistakes (most were reproduced while writing this skill)

1. **Expecting `#[private]` or the non-payable check to fire in unit tests.** Both are generated in the wasm export wrapper, so calling the Rust method directly skips them. Test them in the sandbox. `assert_one_yocto()` and `require!` inside the body *do* run.
2. **Promises are lazy.** Receipts appear in `get_created_receipts()` only after the returned `Promise` is dropped. `let _ = c.method();` drops it immediately. `let p = ...` keeps it alive until scope end.
3. **`res.is_success()` is not enough.** It reports only the final status of the transaction's main chain. A Burrow `execute_with_pyth` whose oracle call fails still returns `is_success() == true`, with 3 failed receipts. Always also check `res.receipt_failures().is_empty()`, or inspect the specific receipt.
4. **`import_contract(..).initial_balance(small)` keeps the MAINNET `storage_usage`.** wrap.near is about 157 MB, so the first call fails with `LackBalanceForState`. Patch `storage_usage` afterwards, keeping `contract_state` (see `mainnet-contracts-in-sandbox.md`). Patching the account with `AccountDetailsPatch::default()` wipes the code hash and gives `CodeDoesNotExist`.
5. **`with_data()` can't pull Ref, Burrow or wrap state.** RPC `view_state` is limited to about 50 KB. Import code only, re-initialize, and seed it yourself.
6. **Stale-oracle failures in the sandbox.** Burrow rejects Pyth prices older than `pyth_price_valid_duration_sec` (60 s) compared with *block* time. Sandbox block time is wall-clock time, so set mock `publish_time` = `worker.view_block().await?.timestamp() / 1e9` right before each borrow.
7. **Using `fast_forward` for day rollover.** Measured: 100 blocks moved the clock only about 30 s, so a full day is impractical. Test day rollover in unit tests with `block_timestamp`, or make the day length a test-only constructor parameter.
8. **Forgetting 1 yocto.** Ref `swap`/`withdraw`/`register_tokens`/`extend_whitelisted_tokens`, Burrow `execute`/`execute_with_pyth`/`add_asset`, and every FT `ft_transfer(_call)` need exactly 1 yoctoNEAR attached.
9. **Forgetting FT storage registration.** Every receiver (Ref, Burrow, the vault, users) must `storage_deposit` on each token first. Otherwise the transfer panics and an `ft_transfer_call` refunds.
10. **Asserting on exact gas from unit tests.** The mocked VM doesn't meter like the real runtime. Gas numbers come only from sandbox `receipt_outcomes()`.
11. **Using `rpc.mainnet.near.org` for imports.** Point the source worker at FastNEAR: `near_workspaces::mainnet().rpc_addr("https://rpc.mainnet.fastnear.com")`. `block_height(..)` imports need an archival RPC.
12. **Hardcoded protocol ids vs. test ids.** The vault hardcodes `wrap.near`, `v2.ref-finance.near`, `contract.main.burrow.near`, `aggregate-oracle.near`. In the sandbox, put the real code, or a mock, **at those exact ids** with `import_contract` / `worker.patch(..)`. Then the production build is the one under test, with no feature flag.

## Reference index

| File | Read when |
|---|---|
| `unit-tests.md` | Writing `#[cfg(test)]` tests: context builder, panics, logs/events, receipts, mocked callback results, day rollover. Includes a verified mini-vault example. |
| `sandbox-integration.md` | Setting up `tests/*.rs` with near-workspaces: building the wasm, accounts, calls, views, logs, failures, fast_forward, gas profiling. |
| `mainnet-contracts-in-sandbox.md` | Getting wrap.near, mock USDC, Ref v2 (pool + liquidity + swap), Burrow (init, assets, supply, borrow) and a mock Pyth oracle running in the sandbox. Includes the full verified recipe. |
| `testnet-and-mainnet.md` | Deciding what to run on testnet (little), and how to run mainnet smoke tests safely and inspect transactions. |

## Test-plan mapping (vault-spec §11)

- **Unit:** policy validation, cap reserve/release, day rollover, HF math vectors, min_out math, owner/agent/stranger and paused/expired checks written in the body.
- **Sandbox:** `#[private]` callbacks, non-payable `agent_*`, all happy paths, attack cases (fake-token pool, pool not allowlisted, price moved past slippage by a big swap, stale or wide-conf mock price, borrow breaching min HF, second action while locked, callback failure paths), and gas constants (measured gas + 30%).
- **Mainnet smoke:** one Burrow loop, one Ref swap, one Intents route, with small amounts. See `testnet-and-mainnet.md`.

## Sources (verified 2026-10-22)

- near-workspaces-rs v0.23.0 README, `examples/src/{ref_finance,spooning,fast_forward}.rs`, `workspaces/src/{rpc/patch.rs,result.rs,worker/impls.rs}`: https://github.com/near/near-workspaces-rs/tree/near-workspaces-v0.23.0
- docs.rs: https://docs.rs/near-workspaces/0.23.0 · https://docs.rs/near-sdk/5.29.1/near_sdk/test_utils/
- near-sdk-rs v5.29.1 `near-sdk/src/test_utils/`, `environment/mock/`, `examples/fungible-token/tests/workspaces.rs`: https://github.com/near/near-sdk-rs/tree/near-sdk-v5.29.1
- cargo-near v0.22.0 project template (`commands/new/test_basics_on.rs.in`): https://github.com/near/cargo-near
- near-sandbox-rs: https://github.com/near/near-sandbox-rs
- docs.near.org testing: https://docs.near.org/smart-contracts/testing/integration-test · CLI: https://docs.near.org/tools/near-cli
- Burrow source (repo shows v0.15.7; mainnet runs 0.16.2): https://github.com/ref-finance/burrowland (`contracts/mock-pyth`, `contracts/contract/src/pyth.rs`, `tests/workspace_env/setup.rs`)
- Ref exchange source: the official `ref-finance/ref-contracts` repo returns 404 as of 2026-10-22. Method names were read from an unofficial mirror (v1.9.18) and confirmed by running mainnet v1.9.20 wasm in the sandbox.
- Live mainnet and testnet RPC views (`get_config`, `get_asset`, `get_token_pyth_info`, `metadata`, `get_price_no_older_than`) on 2026-10-22.
- Every recipe in `unit-tests.md` and `mainnet-contracts-in-sandbox.md` was compiled and run locally on 2026-10-22 (near-sdk 5.29.1 unit tests as printed: 7/7 pass; near-workspaces 0.23.0 sandbox recipe: pass).

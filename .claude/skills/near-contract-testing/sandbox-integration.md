# Sandbox integration tests with near-workspaces 0.23

`near_workspaces::sandbox()` starts a local `neard` in sandbox mode, one process per call, and kills it when the `Worker` is dropped. Real wasm runs in it, so cross-contract calls, callbacks, `#[private]`, payable checks, refunds, storage staking and gas all behave like mainnet.

## Setup

```toml
# vault crate Cargo.toml
[dev-dependencies]
near-workspaces = { version = "=0.23.0", features = ["unstable"] } # "unstable" => compile_project / cargo_near_build re-export
tokio = { version = "1", features = ["full"] }
anyhow = "1"
serde_json = "1"
```

Requirements:
- macOS ARM64 or Linux x86 (near-sandbox-rs README).
- Network on first build: the `install` default feature downloads `neard-sandbox` in `build.rs`. Set `NEAR_SANDBOX_BIN_PATH` to use your own binary.
- For building the contract under test: `rustup target add wasm32-unknown-unknown` and the `cargo-near` 0.22 CLI (`cargo_near_build::build_with_cli` shells out to it).

Useful environment variables:
- `NEAR_ENABLE_SANDBOX_LOG=1`: show neard logs.
- `NEAR_RPC_TIMEOUT_SECS`: default 10.
- `NEAR_SANDBOX_MAX_PAYLOAD_SIZE`: raise it for large state patches.

## Building the contract under test

The current recommended way, used by the cargo-near template, docs.near.org and near-sdk's own FT example, is `cargo_near_build::build_with_cli`. With the `unstable` feature, near-workspaces re-exports it as `near_workspaces::cargo_near_build`.

```rust
use near_workspaces::cargo_near_build;

fn build_vault() -> anyhow::Result<Vec<u8>> {
    let opts = cargo_near_build::BuildOpts {
        manifest_path: Some(cargo_near_build::camino::Utf8PathBuf::from("./Cargo.toml")),
        // features: Some("sandbox".into()),   // if you keep test-only ids behind a feature
        ..Default::default()
    };
    let wasm_path = cargo_near_build::build_with_cli(opts)?;   // runs `cargo near build`
    Ok(std::fs::read(wasm_path)?)
}
```

Alternatives:
- `near_workspaces::compile_project("./path/to/crate").await?` (unstable feature). It is the same thing with `no_locked: true` and default features.
- Prebuild once with `cargo near build non-reproducible-wasm` and `include_bytes!("../target/near/<crate>.wasm")`. This is fastest for big test suites. It is the same file `cargo near build` writes. [VERIFY path for your crate name]

To build once for all tests in a file, use a `std::sync::OnceLock<Vec<u8>>`, or rstest `#[fixture] #[once]` as near-sdk's FT example does.

## Core API (0.23.0)

```rust
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use serde_json::json;

#[tokio::test]
async fn vault_basics() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;                       // "test.near" in 0.23, ~10k NEAR
    let wasm = build_vault()?;

    // accounts
    let owner = root.create_subaccount("owner")              // owner.test.near
        .initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let agent = worker.dev_create_account().await?;           // random dev-*.test.near, 100 NEAR
    let vault: Contract = owner.create_subaccount("vault")
        .initial_balance(NearToken::from_near(20)).transact().await?.into_result()?
        .deploy(&wasm).await?.into_result()?;                 // or worker.dev_deploy(&wasm)

    // init + call with deposit/gas
    vault.call("new").args_json(json!({ "owner": owner.id() })).transact().await?.into_result()?;
    let res = owner.call(vault.id(), "set_agent")
        .args_json(json!({ "agent": agent.id(), "expires_at": null }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(30))                               // workspaces default is 10 Tgas; .max_gas() for chains
        .transact().await?;
    assert!(res.is_success(), "{:?}", res.receipt_failures());

    // view
    let status: serde_json::Value = vault.view("get_status").args_json(json!({})).await?.json()?;
    // or: worker.view(vault.id(), "get_status").await?.json()?

    // NEAR balance
    let bal = owner.view_account().await?.balance;
    Ok(())
}
```

Other calls that exist:
- `account.batch(&id).call(Function::new("m").args_json(..).deposit(..)).transfer(..).transact()`.
- `account.transfer_near(&to, amount)`.
- `worker.view_block()`, `worker.view_state(&id)`, `worker.view_code(&id)`.
- `worker.tx_status(..)`.
- `call(..).transact_async()` for parallel transactions.

## Reading results: logs, values, failures

`transact()` returns `ExecutionFinalResult`:

| Method | Meaning |
|---|---|
| `is_success()` / `is_failure()` | Final status of the transaction's **main** receipt chain only. |
| `into_result()` | `Result<ExecutionSuccess, ExecutionFailure>`. Then `.json::<T>()`, `.borsh()`, `.raw_bytes()`. |
| `json::<T>()` | Shortcut. Errors if the transaction failed. |
| `logs()` | All logs from the transaction and every receipt, including `EVENT_JSON:` lines. |
| `receipt_outcomes()` | `&[ExecutionOutcome]`, one per receipt. Each has `executor_id`, `logs`, `gas_burnt`, `tokens_burnt`, `receipt_ids`, `is_success()/is_failure()`, `into_result()`. |
| `receipt_failures()` / `failures()` | Failed receipts only, without or with the tx outcome. |
| `total_gas_burnt` | Sum over the transaction and all receipts. |

**Detached promises.** A failed inner receipt does **not** flip `is_success()` when the contract didn't return or chain that promise. Measured on Burrow `execute_with_pyth` with a missing oracle: `is_success() == true`, `receipt_failures().len() == 3`. For the vault this is the normal case (spec §6.2), so tests must assert on receipts or on state, not on `is_success()` alone.

```rust
/// Assert fully clean execution (no failed receipt anywhere).
fn assert_clean(res: &near_workspaces::result::ExecutionFinalResult) {
    assert!(res.is_success() && res.receipt_failures().is_empty(),
            "failures: {:#?}", res.receipt_failures());
}

/// Assert a panic message somewhere in the tree. `ExecutionOutcome.status` is pub(crate),
/// so match on the Debug output, which contains "Smart contract panicked: <msg>".
fn assert_panics_with(res: &near_workspaces::result::ExecutionFinalResult, needle: &str) {
    let dbg = format!("{:?}", res.receipt_failures());
    assert!(dbg.contains(needle), "expected `{needle}` in {dbg}");
}

// usage
let res = agent.call(vault.id(), "agent_supply").args_json(json!({"amount":"1"}))
    .deposit(NearToken::from_yoctonear(1)).transact().await?;      // agent methods are non-payable
assert!(res.is_failure());
assert_panics_with(&res, "Method agent_supply doesn't accept deposit"); // near-sdk 5.29 macro text

let res = root.call(vault.id(), "on_supply_done").args_json(json!({"op_id":0,"day":0,"amount":"1"}))
    .transact().await?;
assert_panics_with(&res, "Method on_supply_done is private");          // near-sdk 5.29 macro text
```

Measured failure text (Ref slippage): `FunctionCallError(ExecutionError("Smart contract panicked: panicked at 'E68: slippage error', ref-exchange/src/simple_pool.rs:313:9"))`. near-workspaces' own tests check `"Smart contract panicked: Method doesn't accept deposit"`.

Events: parse them with

```rust
let events: Vec<serde_json::Value> = res.logs().iter()
    .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
    .map(|j| serde_json::from_str(j).unwrap())
    .filter(|e| e["standard"] == "trellis_vault").collect();
```

## Time: `fast_forward`

```rust
let before = worker.view_block().await?;
worker.fast_forward(100).await?;                 // advances height (and timestamp/epoch)
let after = worker.view_block().await?;          // after.timestamp() is ns
```

Measured with 0.23 on 2026-10-22: `fast_forward(100)` advanced height by 103 and time by about 30 s. The cost is about 5 s per epoch crossed (README). It is fine for "lock older than 15 min" (`STALE_LOCK_SECS`). It is **not practical for 24 h day rollover**: do that in unit tests, or give the vault a test-only `day_length_ns` init parameter. Sandbox block time is wall-clock time, so a mock oracle `publish_time` must be refreshed after any fast_forward.

## Gas profiling (fixing callback gas constants)

```rust
fn gas_report(label: &str, res: &near_workspaces::result::ExecutionFinalResult) {
    println!("--- {label}: total {} Tgas", res.total_gas_burnt.as_tgas());
    for o in res.receipt_outcomes() {
        println!("  {:<45} {:>4} Tgas fail={} logs={:?}",
                 o.executor_id.as_str(), o.gas_burnt.as_tgas(), o.is_failure(), o.logs);
    }
}
```

Run with `cargo test -- --nocapture`. Group by `executor_id` to get each hop. Set each callback's static gas to max(observed) × 1.3, and keep total attached gas ≤ 300 Tgas per transaction. The sandbox accepts up to 1 PGas (workspaces 0.22.2 raised `max_gas`), but don't rely on that for mainnet.

Measured burnt gas on the mainnet wasm in the sandbox (2026-10-22). Burnt is not prepaid: attach much more.

| Flow | Total burnt |
|---|---|
| wNEAR `ft_transfer_call` → Ref deposit (5 receipts) | about 7 Tgas |
| Ref `swap`, single simple pool | about 5 Tgas |
| Ref `withdraw` → `ft_transfer` + callback | about 8 Tgas |
| wNEAR `ft_transfer_call` → Burrow `Execute{IncreaseCollateral}` | about 9 Tgas |

`GasMeter::now(&mut worker)` + `.elapsed()` sums gas across all transactions since creation. Useful for "cost of the whole deleverage sequence".

## Test layout suggestion

```
tests/
  common/mod.rs        // build_vault() OnceLock, spoon(), deploy_at(), ft_register(), gas_report()
  owner_agent.rs       // auth, pause, revoke, expiry, private callbacks, non-payable
  burrow_flows.rs      // supply/borrow/repay/withdraw + HF breach + stale/wide price
  ref_flows.rs         // swap happy path, pool not allowlisted, fake-token pool, slippage via price move
  gas.rs               // #[ignore] profiling runs
```

Each `#[tokio::test]` starts its own sandbox, which takes a few seconds. Share setup through helper functions rather than global workers. Tests run in parallel by default; use `cargo test -- --test-threads=4` if the machine struggles.

## Alternative stack: near-sandbox + near-api (cargo-near template)

```rust
let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
let network = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
sandbox.create_account("alice.sandbox".parse()?).initial_balance(NearToken::from_near(10)).send().await?;
// near_api::Contract(..).call_function("m", args)?.transaction().with_signer(..).send_to(&network).await?.assert_success();
sandbox.fast_forward(200).await?;
```

`near-sandbox` also has `create_account(any_id)`, `patch_state(id)`, and `import_account(rpc, id)`. Use it if the rest of the team standardizes on near-api. The API shapes are from the cargo-near 0.22 template and near-sandbox 0.3.16 source. This skill's recipes were not run on that stack.

## Sources (2026-10-22)

- near-workspaces 0.23.0: README; `workspaces/src/result.rs`, `operations.rs`, `worker/impls.rs`, `types/gas_meter.rs`; `tests/{cross_contract,query,gas_meter,deploy_project}.rs`; `examples/src/fast_forward.rs`. https://github.com/near/near-workspaces-rs/tree/near-workspaces-v0.23.0
- near-sdk FT example tests (build_with_cli + fixtures): https://github.com/near/near-sdk-rs/blob/near-sdk-v5.29.1/examples/fungible-token/tests/workspaces.rs
- cargo-near-build 0.11 `BuildOpts`: https://docs.rs/cargo-near-build
- docs.near.org integration tests: https://docs.near.org/smart-contracts/testing/integration-test
- near-sandbox-rs: https://github.com/near/near-sandbox-rs
- Measurements: local run with near-workspaces 0.23.0 against mainnet wasm imported on 2026-10-22.

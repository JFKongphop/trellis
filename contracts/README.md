# Trellis contracts

| Crate | What it is |
|---|---|
| `vault/` | `trellis-vault`: the per-user policy vault (spec: `../docs/vault-spec.md`) |
| `factory/` | `trellis-factory`: creates one vault per user, with no rights afterwards |
| `mock-oracle/` | Test-only stand-in for `aggregate-oracle.near` |
| `integration-tests/` | Sandbox tests against real mainnet wrap.near / Ref v2 / Burrow wasm |

## Requirements

- Rust (stable) with `rustup target add wasm32-unknown-unknown`
- `cargo install cargo-near --version 0.22.0 --locked`

## Build

```bash
(cd vault && cargo near build non-reproducible-wasm)
(cd factory && cargo near build non-reproducible-wasm)
(cd mock-oracle && cargo near build non-reproducible-wasm)
# → target/near/<crate>/<crate>.wasm
```

Always build with `cargo near` (near-sdk 5.27+ needs `--cfg near`, which plain `cargo build` doesn't set).

## Test

```bash
cargo test -p trellis-vault -p trellis-factory            # unit tests
cargo test -p integration-tests -- --test-threads=3        # sandbox tests (build the wasm first; needs internet to import mainnet code)
```

## Deploy to mainnet (global mode)

Users pay ~1.5 NEAR per vault; we pay once to publish the vault code (~10 NEAR per 100 kB, burned; ~40 NEAR for the current 398 KB build).

```bash
# 1. factory account (e.g. trellis.near) with ≥ 47 NEAR, then deploy + init the factory
near contract deploy trellis.near use-file target/near/trellis_factory/trellis_factory.wasm \
  with-init-call new json-args '{"admin":"<admin>.near","mode":"Local"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send

# 2. publish the vault code globally (by hash); the factory switches to Global mode on success
near contract call-function as-transaction trellis.near publish_global_code \
  file-args target/near/trellis_vault/trellis_vault.wasm \
  prepaid-gas '300.0 Tgas' attached-deposit '0 NEAR' sign-as <admin>.near network-config mainnet sign-with-keychain send

# 3. check
near contract call-function as-read-only trellis.near get_mode json-args '{}' network-config mainnet now
near contract call-function as-read-only trellis.near get_min_deposit json-args '{}' network-config mainnet now
```

`new` also takes optional `protocols` (`burrow`, `ref_exchange`, `oracle`, `intents`, `wrap`), fixed for every vault the factory creates. Leave it out on mainnet.

Users then call `create_vault` with `get_min_deposit` attached (the web app does this).

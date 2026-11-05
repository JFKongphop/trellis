# Testnet and mainnet testing

Short version: **for our stack, testnet adds little.** Test logic in unit tests and protocol flows in the sandbox with the real mainnet wasm (`mainnet-contracts-in-sandbox.md`). Then run a few **small-amount mainnet smoke tests** from dedicated accounts. Use testnet only for wallet/UI and agent-key plumbing that doesn't touch Burrow, Ref or Intents.

## What exists on testnet (checked via RPC 2026-10-22)

| Dependency | Mainnet | Testnet | Usable for us? |
|---|---|---|---|
| wNEAR | `wrap.near` | `wrap.testnet` (24 dec) | Yes |
| Ref DEX | `v2.ref-finance.near` (1.9.20) | `ref-finance-101.testnet` (1.9.19, wnear `wrap.testnet`, linked burrow `burrow.services.ref-labs.testnet`); `exchange.ref-dev.testnet` (1.9.17) | Partly. Pools and liquidity are thin and arbitrary. |
| Burrow lending | `contract.main.burrow.near` (0.16.2, pyth = `aggregate-oracle.near`) | `contract.1689937928.burrow.testnet` (**0.11.0**, pyth = `pyth-oracle.testnet`, ref = `exchange.ref-dev.testnet`) | **No.** The version is old and the API differs from 0.16. Its `wrap.testnet` pyth info has a placeholder `price_identifier` (`000…b37928`) plus a hardcoded `default_price` (multiplier 960), so prices are not live. `pyth-oracle.testnet get_price` for the mainnet NEAR id returned `null`. |
| Oracle | `aggregate-oracle.near` | no `aggregate-oracle.testnet` account | No |
| USDC | `17208628…33a1` (6 dec) | `usdc.fakes.testnet` ("USDC.e"), `3e2210e1…b8af` ("USDC") | Only for UI demos |
| NEAR Intents | `intents.near` | `intents.testnet` exists but has **no code** (code_hash `111…`) | **No** |

Our vault hardcodes mainnet ids. A testnet build needs a feature flag with testnet ids (`near-rust-contracts`), and even then Burrow and Intents can't be exercised. Keep testnet scope to:
- Factory and vault deploy (global contract flow).
- Owner methods.
- Agent function-call keys and the worker.
- Wallet connection and transaction rendering in the frontend.

## Testnet accounts

- Create, funded by the faucet (near-cli-rs): `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create`. The short legacy form is `near create-account <name>.testnet --useFaucet --networkId testnet`.
- In Rust, `near_workspaces::testnet().await?.dev_create_account()` creates a random `dev-…testnet` account through the helper/faucet (`helper.testnet.near.org`). It's handy for CI-style testnet runs, but the faucet is rate limited. [VERIFY helper still issues accounts]
- RPC: `https://rpc.testnet.fastnear.com`. Explorer: `https://testnet.nearblocks.io/txns/<hash>`.

## Mainnet smoke-test practice

Separate accounts:
- One **owner** test account, for example `trellis-smoke-owner.near`, with a fresh key held only in the CLI keychain or a hardware wallet. It is not the team's main wallet.
- One **agent** account (`trellis-smoke-agent.near`) holding only a function-call key scoped to the vault's `agent_*` methods, with a gas allowance (`add-key grant-function-access --allowance '0.25 NEAR' --contract-account-id <vault> --function-names agent_supply,agent_borrow,...`). [VERIFY exact near-cli-rs flag names with `near account add-key --help`]
- The vault as a subaccount, for example `smoke1.trellis.near`. Don't reuse a vault across contract versions. Deploy a fresh one per release candidate.

Caps:
- Fund the vault with **$20–50**: for example 5 NEAR and 10 USDC.
- Set the policy so the worst case is tiny: `per_action_cap` ≤ $10, `daily_cap` ≤ $20, `min_health_factor_bps` ≥ 15000 (1.5), `max_slippage_bps` ≤ 100, Intents off until verified.
- Keep about 1 NEAR in the owner account for storage, 1-yocto calls and gas.

Order of smoke tests (each one done when explorer shows no failed receipt and the vault views match):
1. Deposit wNEAR and USDC (FT `ft_transfer_call` with vault msg).
2. `owner` `withdraw_ft`: the escape hatch, proven before anything else.
3. Agent `agent_supply` 1 wNEAR to Burrow, then `sync_position`, then compare `get_account_all_positions(vault)`.
4. Agent `agent_borrow` $1 USDC (`execute_with_pyth`), then `sync_position` reconcile, then `agent_repay`, then `agent_withdraw_collateral`.
5. One `agent_swap_ref` on an allowlisted, liquid wNEAR/USDC pool. Check the vault-computed `min_out` against the received amount.
6. Negative checks on mainnet (cheap): an agent call over the cap, after `pause`, and after `revoke_agent`. All should fail with policy errors and move no funds.
7. Intents route plus withdraw, only after the quote-signature [VERIFY] items in the spec are resolved.
8. Finally: the owner withdraws everything, and the owner closes the Burrow position with `owner_burrow` if needed.

Hygiene:
- Script each step with near-cli-rs or a small near-api-js script, and log every transaction hash to a file.
- Never paste full-access private keys into the agent worker's environment.
- Pin `near-sdk 5.29.1` and build with `cargo near build reproducible-wasm` for the deployment you show judges.

## Inspecting results

Explorers:
- `https://nearblocks.io/txns/<tx_hash>` (mainnet) and `https://testnet.nearblocks.io/txns/<tx_hash>`. The receipts tab shows every receipt, its gas, its logs, and failures; FT transfers appear under token transfers.
- An account's history: `https://nearblocks.io/address/<account_id>`.

CLI:
- `near transaction view-status <tx_hash> network-config mainnet`
- Short form: `near tx-status <tx_hash> --networkId mainnet`

Raw RPC, with all receipts and outcomes (FastNEAR mainnet: `https://rpc.mainnet.fastnear.com`):

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":"1","method":"EXPERIMENTAL_tx_status",
  "params":{"tx_hash":"<TX_HASH>","sender_account_id":"<SIGNER_ID>","wait_until":"FINAL"}}' \
| jq '{status: .result.status,
       receipts: [.result.receipts_outcome[] | {executor: .outcome.executor_id,
                  gas: .outcome.gas_burnt, logs: .outcome.logs, status: .outcome.status}]}'
```

Use `"method":"tx"` for the same data without the full receipt bodies. A transaction can show `SuccessValue` at the top while one receipt shows `Failure`. This is the same "detached promise" effect as in the sandbox, so always scan `receipts_outcome[].outcome.status`.

Views after each step:

```bash
near contract call-function as-read-only <vault> get_status json-args '{}' network-config mainnet now
near contract call-function as-read-only contract.main.burrow.near get_account_all_positions json-args '{"account_id":"<vault>"}' network-config mainnet now
```

## Sources (2026-10-22)

- RPC views on testnet and mainnet, run 2026-10-22: Burrow `get_version`/`get_config`, Ref `metadata`, `ft_metadata`, `view_account intents.testnet`, `pyth-oracle.testnet get_price`.
- near-cli-rs commands: https://docs.near.org/tools/near-cli
- near-workspaces testnet helper URL constants (`workspaces/src/network/testnet.rs`, v0.23.0): https://github.com/near/near-workspaces-rs
- RPC `tx` / `EXPERIMENTAL_tx_status`: https://docs.near.org/api/rpc/transactions
- Project research: `docs/research.md` (testnet status, Burrow oracle state), `docs/vault-spec.md` §11.

# Trellis worker

Background agent for Trellis vaults. Every tick (default 15 s), for each registered vault it:

1. **Reconciles** a submitted vault operation (`sync_position`) if one is pending.
2. **Protects** the position: when the health factor drops below the policy's `deleverage_trigger`, it runs a
   deleverage session (repay from idle funds, or withdraw collateral → swap on Ref → repay) until the health factor is
   back above `min_health_factor`. Withdrawals are sized so the health factor never goes below `emergency_floor + margin`.
3. Otherwise **runs the next owner-approved plan** sent by the web app.

The vault contract checks every action against the owner's rules, so a worker bug wastes gas but can't break them.
Every action's reasoning is appended to `DATA_DIR/reasoning.jsonl`; its sha256 is the `reason_hash` stored on-chain.

## Setup

```bash
pnpm install
cp .env.example .env    # set AGENT_KEY_SEED, WORKER_API_TOKEN, VAULTS
```

Each vault needs a function-call key on the agent account (derived from `AGENT_KEY_SEED`). Print the key and the
`near` CLI command to add it (run by the operator with the agent's full-access key, which never lives on the worker):

```bash
pnpm provision <vault-account-id> [allowance NEAR]
```

## Run

```bash
pnpm start          # or: pnpm dev
```

## HTTP API (for the web app; bearer `WORKER_API_TOKEN`)

| Method | Path | Body / result |
|---|---|---|
| GET | `/healthz` | `{ ok, lastTickAt, lastError, vaults }` (no auth) |
| POST | `/vaults` | `{ vaultId, owner }`: start monitoring a vault |
| POST | `/plans` | `{ planId, vaultId, owner, steps: [{ method, args, label }], reasoning }` → 202 `{ planId }` |
| GET | `/plans/:id` | `{ planId, vaultId, status, steps: [{ label, method, status, txHash?, note? }], error? }` |
| GET | `/vaults/:id/reasons` | `{ reasons: [{ hash, source: "auto_protection" \| "owner_approved_plan" \| "other", why, hfBefore, at, txHash? }] }`, newest last; `hash` = the receipt's `reason_hash`. The web app uses it for the ⚡ tag and the "while you were away" banner. |
| GET | `/vaults` | `{ vaults: string[] }`: the vault ids this worker protects (no owners). Used by the web `/feed`. |

Only `agent_*` methods (not `sync_position`) are accepted as plan steps, at most 10, and `args` must not include
`reason_hash` (the worker adds it). After 3 consecutive failures on a vault the worker stops acting on it and logs
`ALERT_breaker_open`.

## Test

```bash
pnpm test                 # decision + math unit tests (vectors shared with the contract)
pnpm typecheck
# end-to-end against a sandbox with real Burrow/Ref code:
cd ../contracts && cargo test -p integration-tests --test worker_e2e -- --nocapture
```

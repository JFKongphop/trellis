# Agent worker: account, keys, signing, loop, hosting

Verified 2026-10-22: near-api-js 7.3.1 source (Account, NonceManager, FailoverRpcProvider), `@fastnear/api` 2.5.0
d.ts, js.fastnear.com/gas-keys.html, docs.near.org/tools/cli (gas keys), near-cli-rs GUIDE (grant-function-call-access).
Policy enforcement lives in the vault (vault-spec §5.3); this file is about the off-chain side.

## 1. Accounts and keys

| Account / key | Where it lives | Can do |
|---|---|---|
| `agent.trellis.near` full-access key | offline (hardware wallet / password manager), plus a separate provisioning job if automated | add/delete keys on the agent account |
| one **function-call key per vault** on `agent.trellis.near` | worker secret store | call only `agent_*` + `sync_position` on that one vault, no deposit, gas up to allowance |
| relayer (optional, `near-frontend/gasless-and-data.md`) | web server | pays gas for user meta-txs |

Function-call key rules (protocol): one `receiver_id`; `method_names` empty = any method on that receiver;
**cannot attach a deposit** (so all agent methods are non-payable); `allowance` = NEAR it may burn on gas over its
lifetime, `None` = unlimited; when spent, txs fail with `NotEnoughAllowance` and the allowance can't be raised
(delete + re-add a key). Each key adds storage to the agent account (keep a few NEAR there).

Creating the agent account (once): `near account create-account fund-myself agent.trellis.near '5 NEAR' …` from
`trellis.near`, or any wallet. Keep ≥ 3–5 NEAR: it pays gas for every agent tx (gas is ~0.0001 NEAR per Tgas at
the 100 Mgas-price floor; a 300 Tgas call burns at most ~0.03 NEAR, usually far less).

```ts
export const AGENT_METHODS = [
  "agent_wrap_near", "agent_supply", "agent_repay", "agent_borrow", "agent_withdraw_collateral",
  "agent_withdraw_supplied", "agent_swap_ref", "recover_ref", "agent_route_intents", "agent_intents_withdraw",
  "sync_position",
]; // must match the vault's method names exactly (contracts/vault; worker/src/config.ts is the source of truth)
```

### Add a per-vault key with near-api-js (provisioning script, full-access key)

```ts
// scripts/add-vault-key.ts — run by an operator (or a locked-down provisioning job), never inside the worker
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from "near-api-js";

const provider = new FailoverRpcProvider([new JsonRpcProvider({ url: "https://free.rpc.fastnear.com" })]);
const admin = new Account("agent.trellis.near", provider, process.env.AGENT_FULL_ACCESS_KEY as KeyPairString);

export async function addVaultKey(vaultId: string) {
  const kp = KeyPair.fromRandom("ed25519");
  await admin.addFunctionCallAccessKey({
    publicKey: kp.getPublicKey(),
    contractId: vaultId,
    methodNames: AGENT_METHODS,
    allowance: nearToYocto("1"),          // gas budget for this vault's lifetime; monitor + rotate
  });
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() }; // store secretKey in the secret store
}
export const removeVaultKey = (publicKey: string) => admin.deleteKey(publicKey);
```

Batch variant (many vaults, one tx): `admin.signAndSendTransaction({ receiverId: "agent.trellis.near",
actions: vaults.map(v => actions.addFunctionCallAccessKey(pk(v), v, AGENT_METHODS, nearToYocto("1"))) })`.

### Same with near CLI (near-cli-rs)

```bash
near account add-key agent.trellis.near \
  grant-function-call-access \
    --allowance '1 NEAR' \
    --contract-account-id alice-near.trellis.near \
    --function-names 'agent_supply, agent_borrow, agent_repay, agent_withdraw_collateral, agent_swap_ref, sync_position' \
  use-manually-provided-public-key ed25519:<PUBKEY> \
  network-config mainnet \
  sign-with-keychain \
  send

near account list-keys agent.trellis.near network-config mainnet now        # check permissions/allowance
near account delete-keys agent.trellis.near public-keys ed25519:<PUBKEY> network-config mainnet sign-with-keychain send  # [VERIFY] subcommand spelling
```

### Deterministic per-vault keys (one secret instead of N)

```ts
import { createHmac } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";  // same path near-api-js 7.3.1 imports (@noble/curves 2.2.0); add it as a direct dep
import { baseEncode, KeyPairSigner, type KeyPairString } from "near-api-js";

export function vaultKey(vaultId: string): KeyPairString {
  const seed = createHmac("sha256", process.env.AGENT_KEY_SEED!).update(`trellis-agent:v1:${vaultId}`).digest(); // 32 bytes
  const pub = ed25519.getPublicKey(seed);
  return `ed25519:${baseEncode(new Uint8Array([...seed, ...pub]))}` as KeyPairString; // NEAR secret = seed‖pubkey (64 bytes)
}
export const signerFor = (vaultId: string) => KeyPairSigner.fromSecretKey(vaultKey(vaultId));
```
Leak of `AGENT_KEY_SEED` = all vault keys, but each key is still bounded by the vault policy, and owners can
`revoke_agent` instantly. Rotate by bumping `v1` → `v2` and re-adding keys.

## 2. Gas keys (NEP-611) — real, stretch option

Live since protocol 85 (mainnet reports 86). A gas key is an access key with **its own NEAR balance** for gas and
**1–1024 nonce lanes** (parallel sends without collisions).
- Permission `GasKeyFunctionCall { balance, num_nonces, receiver_id, method_names }` — same scoping as an FC key, no
  allowance (the balance is the cap). Starts at 0; **anyone** can fund it with `TransferToGasKey` (the vault owner could
  top up their own agent key). Only the owner account can `WithdrawFromGasKey`. `DeleteKey` refuses above 1 NEAR and
  burns the rest → drain first.
- Signing needs `TransactionV1` with a `GasKeyNonce { nonce, nonceIndex }`. near-api-js 7.3.1 can't build that; use
  `@fastnear/api` `sendTx({ signerId, signer, receiverId, actions, nonceIndex, waitUntil })`.
- Gas keys can't sign NEP-366 delegates (per FastNEAR docs). CLI: `near account add-key … grant-gas-key-full-access
  --num-nonces 8`, `fund-gas-key`, `view-gas-key-nonces`, `withdraw-from-gas-key`, `--nonce-index 3` on send.

```ts
import * as near from "@fastnear/api";
import { signerFromPrivateKey } from "@fastnear/utils";
near.config({ networkId: "mainnet" });

// add (signed by agent full-access key) — addLimitedAccessGasKey({ publicKey, numNonces, accountId, methodNames })
await near.sendTx({ signerId: "agent.trellis.near", signer: signerFromPrivateKey(FULL_KEY), receiverId: "agent.trellis.near",
  actions: [near.actions.addLimitedAccessGasKey({ publicKey: gasPub, numNonces: 4, accountId: vaultId, methodNames: AGENT_METHODS })],
  waitUntil: "FINAL" });
// fund (any account)
await near.sendTx({ signerId: "trellis.near", signer: funder, receiverId: "agent.trellis.near",
  actions: [near.actions.transferToGasKey({ publicKey: gasPub, deposit: "0.5 NEAR" })], waitUntil: "FINAL" });
// send on lane 2
await near.sendTx({ signerId: "agent.trellis.near", signer: signerFromPrivateKey(gasSecret), receiverId: vaultId,
  actions: [near.actions.functionCall({ methodName: "sync_position", args: {}, gas: "100 Tgas", deposit: "0" })],
  nonceIndex: 2, waitUntil: "EXECUTED_OPTIMISTIC" });
```
For Trellis the vault already allows one in-flight op, so lanes buy little; the real win is "owner can top up the
agent's gas". MVP: classic FC keys.

## 3. Signing from Node + nonces

```ts
import { Account, JsonRpcProvider, actions, teraToGas } from "near-api-js";
const sendProvider = new JsonRpcProvider({ url: process.env.RPC_URL ?? "https://free.rpc.fastnear.com" });
const agent = new Account("agent.trellis.near", sendProvider);   // ONE instance per process (holds NonceManager)

export async function callVault(vaultId: string, method: string, args: Record<string, unknown>, tgas = 300) {
  return agent.signAndSendTransaction({
    receiverId: vaultId,
    actions: [actions.functionCall(method, args, teraToGas(String(tgas) as `${number}`), 0n)],
    signer: signerFor(vaultId),
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
}
```
- Nonces are per access key. Different vaults = different keys = fully parallel. Same key in one process: the
  NonceManager hands out increasing nonces and retries `InvalidNonce` up to 10×.
- Don't send through `FailoverRpcProvider` (it converts `InvalidNonce` into `RetriesExceeded`, disabling the retry).
  Do failover yourself: on transport errors, re-send the **same signed tx** (`createSignedTransaction` once, then
  `sendTransactionUntil` on the next provider) — identical bytes can't double-apply.
- One process owns all keys. If you scale out, shard vaults across processes (hash(vaultId) % N), never share a key.
- 300 Tgas max per tx (and per function call). Burrow/Ref chains in the vault need sandbox gas profiling.

## 4. The loop

```ts
const TICK_MS = 15_000;
const MAX_PARALLEL = 8;

type Job = { vaultId: string; kind: "deleverage" | "stop_loss" | "dca" | "sync"; args: Record<string, unknown>; reasonHash: string };

async function tick() {
  const vaults = await listActiveVaults();                       // DB (populated from factory events) or factory view
  await mapLimit(vaults, MAX_PARALLEL, async (v) => {
    if (breaker.isOpen(v.id)) return;
    const status = await view(v.id, "get_status");                // { paused, agent, in_flight, ... }
    if (status.paused || status.agent !== "agent.trellis.near") return;
    if (status.in_flight) return enqueue({ vaultId: v.id, kind: "sync", args: {}, reasonHash: "sync" }); // finish Submitted op
    const pos = await readPosition(v.id);                         // Burrow positions + oracle prices (rhea-burrow-lending)
    const job = decide(v.policy, pos, v.orders);                  // pure, deterministic, unit-tested
    if (job) await enqueue(job);
  });
  await heartbeat();
}

async function run(job: Job) {
  const key = `${job.vaultId}:${job.kind}:${job.reasonHash}`;    // idempotency key
  if (await db.pendingTx(key)) return;                           // already sent; reconcile path handles it
  const signed = await agent.createSignedTransaction({ receiverId: job.vaultId, signer: signerFor(job.vaultId),
    actions: [actions.functionCall(`agent_${job.kind}`, { ...job.args, reason_hash: job.reasonHash }, teraToGas("300"), 0n)] });
  await db.recordPending(key, signed);                           // persist before sending (tx hash is deterministic)
  const out = await sendWithFailover(signed);
  await db.recordResult(key, out);                               // parse trellis_vault events (near-frontend/near-api-js.md)
}
```
Design rules:
- **Deterministic decisions** (`decide`) for money moves: HF < `min_health_factor + margin` → deleverage step;
  price ≤ stop → exit; DCA schedule. The vault re-checks everything, so a worker bug wastes gas but can't break policy.
- **Re-check right before sending** (fresh views at `finality: "final"`); state may have changed during the tick.
- **One op per vault** (vault has an `in_flight` lock): if `in_flight` is set, only `sync_position`.
- **Idempotency**: key = vault + action + `reason_hash`; persist the signed tx before sending; on restart, look up
  pending hashes with `viewTransactionStatus` before re-deciding.
- **Backoff**: exponential with full jitter on RPC/transport errors (250 ms → 30 s); per-vault circuit breaker after
  3 consecutive contract failures (e.g. `policy_violation`) — alert, don't loop.
- **Allowance watch**: `viewAccessKey` each hour; rotate key below 0.1 NEAR left. Watch agent account balance too.
- **Health-factor math**: compute exactly like the vault (same oracle, same decimals) so the worker never proposes
  an action the vault will reject. Share test vectors with the contract tests.
- LLM (optional) only proposes *parameters* within the deterministic envelope; record its signed output and hash it
  into `reason_hash` (see near-ai-cloud.md §6).

## 5. Hosting, secrets, heartbeat

- **Railway**: a service from the worker folder (Dockerfile or Nixpacks `npm start`), no public port needed, set
  restart policy "always". Secrets in Railway variables (`AGENT_KEY_SEED`, `RPC_URL`, `NEARAI_API_KEY`, `DATABASE_URL`).
- **Fly.io**: `fly launch --no-deploy`, remove `[http_service]` for a pure worker (or keep a tiny `/healthz` and set
  `auto_stop_machines = "off"`, `min_machines_running = 1`) [VERIFY keys against current fly.toml docs]; `fly secrets set …`.
- Not Vercel cron: functions are short-lived and serverless instances can overlap (double-sending with one key).
- **Key storage**: platform secret env vars for the hackathon; never commit, never log (`KeyPairSigner` only).
  Full-access agent key stays off the worker. Stretch: OutLayer custody (outlayer.md).
- **Heartbeat**: each tick writes `{ lastTickAt, vaultsChecked, lastError }` to Redis/DB and serves `/healthz`.
  A Cloudflare Worker cron (every 1–5 min) fetches it and posts to Discord/Telegram if stale > 2 min; also alert on
  agent balance < 1 NEAR and on any `policy_violation` event.
- Graceful shutdown: on SIGTERM stop taking new jobs, await in-flight sends, then exit (platform redeploys).
- Logs: one JSON line per decision `{ vault, kind, reasonHash, txHash, hfBefore, hfAfter }` → doubles as the
  reasoning log the `reason_hash` points to.

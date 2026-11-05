# near-api-js v7 (7.3.1): reads, server signing, outcomes, events

Verified against `near-api-js@7.3.1` `lib/index.d.ts`, `lib/account-*.d.ts`, `lib/index.js` (2026-10-22).
v7 is one package (`near-api-js`, plus subpaths `near-api-js/nep413`, `near-api-js/tokens`,
`near-api-js/tokens/mainnet`, `near-api-js/seed-phrase`, `near-api-js/rpc-errors`). ESM + CJS, Node 18+.

## v4/v5 → v7 cheat sheet

| Old (don't write this) | v7 |
|---|---|
| `connect({ networkId, keyStore, nodeUrl })` | `new JsonRpcProvider({ url })` |
| `keyStores.InMemoryKeyStore` + `KeyPair.fromString` | `KeyPairSigner.fromSecretKey("ed25519:…")` or pass the key string to `Account` |
| `account.viewFunction({ contractId, methodName, args })` | `provider.callFunction({ contractId, method, args })` |
| `account.functionCall({ contractId, methodName, args, gas, attachedDeposit })` | `account.callFunction({ contractId, methodName, args, gas, deposit })` |
| `account.state()` / `getAccountBalance()` | `account.getState()` → `{ balance: { total, usedOnStorage, locked, available }, storageUsage, codeHash }` (bigints) |
| `utils.format.parseNearAmount("1")` | `nearToYocto("1")` (bigint); `yoctoToNear(x, 2)`; `teraToGas("30")` |
| `transactions.functionCall(...)` | `actions.functionCall(method, args, gas: bigint, deposit: bigint)` |
| `providers.getTransactionLastResult` | `getTransactionLastResult(outcome)` (top-level export) |

## Providers and failover

```ts
// src/lib/near/provider.ts
import { FailoverRpcProvider, JsonRpcProvider } from "near-api-js";

const FASTNEAR_KEY = process.env.FASTNEAR_API_KEY; // optional; free tier works without

export const rpcUrls = [
  FASTNEAR_KEY ? `https://rpc.mainnet.fastnear.com?apiKey=${FASTNEAR_KEY}` : "https://free.rpc.fastnear.com",
  "https://near.drpc.org",          // listed on docs.near.org/api/rpc/providers (free tier)
  "https://rpc.mainnet.near.org",   // last resort, rate-limited
];

// Reads (UI + routes): failover across providers.
export const provider = new FailoverRpcProvider(rpcUrls.map((url) => new JsonRpcProvider({ url })));

// Writes (worker / relayer): ONE JsonRpcProvider, see "Failover gotcha".
export const sendProvider = new JsonRpcProvider({ url: rpcUrls[0] }, { retries: 3, wait: 500, backoff: 1.5 });
```
`JsonRpcProvider(connectionInfo: { url, headers? }, options?: { retries, wait, backoff })` — defaults 12 retries,
500 ms, ×1.5 on transient errors.

**Failover gotcha (from source):** `FailoverRpcProvider.withBackoff` catches **every** error except
`AccountDoesNotExistError`, logs it, switches provider, and finally throws `TypedError("Exceeded N providers…",
"RetriesExceeded")`. So a contract panic in a view call, or `InvalidNonceError` on send, comes back as
`RetriesExceeded` and `Account.signAndSendTransaction`'s built-in nonce retry never fires. A view that returns
`undefined` is also treated as "try next". Use failover for reads; send with a single provider and do your own failover.

## View calls

```ts
import { provider } from "@/lib/near/provider";

// Generic typed view (args are JSON; result is JSON-parsed)
const policy = await provider.callFunction<VaultPolicy>({
  contractId: vaultId, method: "get_policy", args: {},
  // blockQuery: { finality: "final" } | { blockId: 123 }   (default optimistic)
});

// Raw (logs, block height)
const raw = await provider.callFunctionRaw({ contractId: vaultId, method: "get_status", args: {} });
// raw.result: number[] bytes, raw.logs: string[], raw.block_height

// Account state
const view = await provider.viewAccount({ accountId: vaultId, blockQuery: { finality: "final" } });
// view.amount, view.locked (bigint), view.storage_usage, view.code_hash

// Access keys (e.g. confirm the agent FC key for a vault exists)
const keys = await provider.viewAccessKeyList({ accountId: "agent.trellis.near" });
const k = await provider.viewAccessKey({ accountId: "agent.trellis.near", publicKey: "ed25519:…" });
// k.nonce (bigint), k.permission: "FullAccess" | { FunctionCall: { receiver_id, method_names, allowance } }
```
`callFunction` returns `T | undefined` on the Provider interface; guard for undefined.

## FT balances

```ts
import { Account, FungibleToken } from "near-api-js";
import { USDC, USDT, wNEAR } from "near-api-js/tokens/mainnet";
// USDC = 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 (6 dp), USDT = usdt.tether-token.near (6), wNEAR = wrap.near (24)

const usdc = await USDC.getBalance({ accountId: vaultId, provider });   // bigint (calls ft_balance_of)
USDC.toUnits("12.5");                                                   // 12500000n
USDC.toDecimal(usdc, 2);                                                // "12.50" (string)

// Any token
const t = new FungibleToken("token.v2.ref-finance.near", { name: "Ref", symbol: "REF", decimals: 18 });
const meta = await provider.callFunction<{ decimals: number; symbol: string }>({ contractId: t.accountId, method: "ft_metadata", args: {} });

// Native NEAR (available = total - storage-locked)
const { balance } = await new Account(vaultId, provider).getState();   // balance.available: bigint
```
For many balances at once use FastNEAR `GET /v1/account/{id}/ft` (see `gasless-and-data.md`) and only
call `ft_balance_of` for the tokens you show.

## Sending transactions from a server key

The worker signs as `agent.trellis.near` with a **per-vault function-call key** (receiver = that vault). FC keys can't
attach deposit, so every agent call has `deposit = 0n`.

```ts
import "server-only";
import { Account, KeyPairSigner, actions, teraToGas, getTransactionLastResult, type KeyPairString } from "near-api-js";
import { sendProvider } from "@/lib/near/provider";

const AGENT_ID = "agent.trellis.near";
// One Account instance per process; keep it — its NonceManager caches nonces per public key.
const agent = new Account(AGENT_ID, sendProvider);
const signers = new Map<string, KeyPairSigner>(); // vaultId -> signer for that vault's FC key

export function signerFor(vaultId: string) {
  let s = signers.get(vaultId);
  if (!s) {
    const sk = loadVaultKey(vaultId) as KeyPairString; // from your secret store, never logged
    s = KeyPairSigner.fromSecretKey(sk);
    signers.set(vaultId, s);
  }
  return s;
}

export async function agentCall(vaultId: string, methodName: string, args: object, tgas = 300) {
  const outcome = await agent.signAndSendTransaction({
    receiverId: vaultId,
    actions: [actions.functionCall(methodName, args, teraToGas(String(tgas) as `${number}`), 0n)],
    signer: signerFor(vaultId),       // per-call signer override
    waitUntil: "EXECUTED_OPTIMISTIC", // default; "FINAL" for settlement checks
    throwOnFailure: true,             // default: throws a parsed error if the tx status is Failure
  });
  return { hash: outcome.transaction_outcome.id, value: getTransactionLastResult(outcome), outcome };
}
```
Shortcut: `account.callFunction({ contractId, methodName, args, gas, deposit, waitUntil })` returns the parsed
last result; `callFunctionRaw` returns the full outcome. Both use the Account's own signer (set it with
`new Account(id, provider, signer)` or `account.setSigner(s)`), so use one `Account` per key if you prefer that style.

`waitUntil` values: `NONE | INCLUDED | EXECUTED_OPTIMISTIC | INCLUDED_FINAL | EXECUTED | FINAL`.

### Nonce behaviour (from source)
- `NonceManager.resolveNextNonce` reads the key's nonce once (optimistic finality), then increments locally;
  concurrent sends on the **same key** in one process get distinct nonces.
- On `InvalidNonceError` the account invalidates the cache and retries (default `retries = 10`).
- Keys are independent: parallel calls to different vaults (different FC keys) never collide.
- Two processes using the same key will collide; give each worker its own keys or a gas key with nonce lanes
  (gas keys need `@fastnear/api` `sendTx`; near-api-js 7.3.1 has gas-key error types but no TransactionV1 signing).
- `MultiKeySigner` rotates several keys of one account for throughput (README "Parallel Transactions").

## Transaction status + outcome parsing

```ts
import { provider } from "@/lib/near/provider";

const tx = await provider.viewTransactionStatus({ txHash, accountId: AGENT_ID, waitUntil: "FINAL" });
// (viewTransactionStatusWithReceipts adds the receipt bodies)

type Outcome = typeof tx;
export function failedReceipts(o: Outcome) {
  return o.receipts_outcome
    .filter((r) => typeof r.outcome.status === "object" && "Failure" in (r.outcome.status as object))
    .map((r) => ({ id: r.id, executor: r.outcome.executor_id, failure: (r.outcome.status as any).Failure }));
}
export const txSucceeded = (o: Outcome) =>
  typeof o.status === "object" && "SuccessValue" in (o.status as object) && failedReceipts(o).length === 0;
```
- `status.SuccessValue` (base64) is the **last receipt's** return; `getTransactionLastResult` decodes it as JSON.
- Cross-contract chains (vault → Burrow → callback) can fail in a later receipt while the tx still shows success.
  Trellis's vault emits `action_failed`; prefer events over raw receipt status for UX.
- Explorer links: `https://nearblocks.io/txns/${hash}`.

## NEP-297 events (`EVENT_JSON:` logs)

```ts
export type NepEvent<T = unknown> = { standard: string; version: string; event: string; data: T };

export function parseEvents(o: Outcome, filter?: { standard?: string; emitter?: string }): Array<NepEvent & { receiptId: string; emitter: string }> {
  const out = [];
  for (const r of o.receipts_outcome) {
    if (filter?.emitter && r.outcome.executor_id !== filter.emitter) continue; // trust only the expected contract
    for (const log of r.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const ev = JSON.parse(log.slice("EVENT_JSON:".length)) as NepEvent;
        if (filter?.standard && ev.standard !== filter.standard) continue;
        out.push({ ...ev, receiptId: r.id, emitter: r.outcome.executor_id });
      } catch { /* non-JSON log, ignore */ }
    }
  }
  return out;
}

// Trellis vault receipts
const events = parseEvents(outcome, { standard: "trellis_vault", emitter: vaultId });
const settled = events.filter((e) => e.event === "action_settled");
```
Always filter by `executor_id`: any contract can log a string that looks like a `trellis_vault` event.
For views without a tx, read the vault's `get_receipts` ring buffer; for history use NearBlocks (see `gasless-and-data.md`).

## Error handling

- `throwOnFailure` throws errors parsed from `status.Failure` (e.g. `FunctionCallError` with the panic string).
  Show `err.message`; keep the tx hash from `err.context`/the outcome for the explorer link. [VERIFY] exact class
  names you branch on — import from `near-api-js/rpc-errors`.
- Every `TypedError` has `.type`; `RetriesExceeded` means the failover gave up (see gotcha above).
- `AccountDoesNotExistError` is thrown for unknown accounts — use it for "vault not created yet" UI.

## Building but not sending (e.g. preview in the transaction viewer)

```ts
const unsigned = await new Account(AGENT_ID, provider).createTransaction({ receiverId, actions: [...], publicKey });
const { signedTransaction } = await KeyPairSigner.fromSecretKey(sk).signTransaction(unsigned);
await sendProvider.sendTransactionUntil(signedTransaction, "FINAL");
```

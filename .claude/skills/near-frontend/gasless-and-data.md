# Gasless (NEP-366 meta transactions) + data APIs

Verified 2026-10-22 against `@fastnear/api@2.5.0` / `@fastnear/utils@2.5.0` type defs, near-api-js 7.3.1 source,
js.fastnear.com/meta-transactions.html, docs.near.org/protocol/transactions/meta-tx, and live HTTP probes.

## Part 1: meta transactions

### How NEP-366 works (what matters for Trellis)
- The **user** signs a `DelegateAction { senderId, receiverId, actions, nonce, maxBlockHeight, publicKey }` with an
  access key of `senderId`. No gas is spent and the user needs no NEAR balance for gas.
- A **relayer** wraps it in a normal transaction (`receiverId = senderId`, one `SignedDelegate` action) and pays.
- The relayer pays **gas and any deposits attached to inner actions** (docs.near.org meta-tx page). If an inner action
  fails, the deposit refund goes to the **user**, not the relayer. → a relayer must cap deposits.
- One receiver per delegate; one delegate per transaction; no nesting. The sender account must already exist.
- Function-call keys can sign delegates only for the calls they're allowed (allowance isn't checked; the relayer pays).
- `maxBlockHeight` = expiry; libs default to current height + TTL (near-api-js 200 blocks, set your own).
- Gas keys (NEP-611) and delegates: fastnear docs say a gas key **cannot** sign a delegate; docs.near.org mentions a
  "V2 delegate with GasKeyNonce signed by a gas key". Conflicting → treat gas-key delegates as unsupported. [VERIFY]

### When Trellis should use it
Most Trellis users already hold NEAR (vault creation needs ~1 NEAR deposit, and a relayer must **never** pay that).
Good candidates: owner panic buttons (`pause`, `revoke_agent`) and `set_policy` — 0 or 1 yocto deposit, so sponsorship
costs only gas. Treat gasless as a nicety, not core. Agent-side transactions are paid by `agent.trellis.near` already.

Note `assert_one_yocto` still works through a delegate: the user's key signs the inner FunctionCall with 1 yocto, the
relayer pays that yocto, and only a full-access key can sign actions with a deposit (wallets use full-access keys).

### Client: wallet signs the delegate (near-connect)

```ts
"use client";
import type { NearWalletBase } from "@hot-labs/near-connect";

export async function gaslessOwnerCall(wallet: NearWalletBase, vaultId: string, methodName: string, args: object) {
  if (!wallet.manifest.features.signDelegateActions) throw new Error("Wallet can't sign meta transactions");
  const { signedDelegateActions } = await wallet.signDelegateActions({
    delegateActions: [{
      receiverId: vaultId,
      actions: [{ type: "FunctionCall", params: { methodName, args, gas: "30000000000000", deposit: "1" } }],
    }],
  });
  // Each entry is base64 borsh(SignedDelegate) (seen in ledger + intear executors). [VERIFY] per wallet:
  // some may return { borshSerializedBase64 } objects; parseSignedDelegate accepts both.
  const res = await fetch("/api/relay", { method: "POST", body: JSON.stringify({ signedDelegate: signedDelegateActions[0] }) });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ txHash: string }>;
}
```
Wallets with `signDelegateActions` in the live manifest: HOT, Meteor, Intear, Ledger, NEAR Mobile, near-cli
(not MyNearWallet, OKX, Nightly, WalletConnect). Offer a "pay gas yourself" fallback.

### Server: Next.js relay route with @fastnear/api

```ts
// src/app/api/relay/route.ts
import "server-only";
import * as near from "@fastnear/api";
import { parseSignedDelegate, signerFromPrivateKey } from "@fastnear/utils";

export const runtime = "nodejs";

near.config({ networkId: "mainnet", ...(process.env.FASTNEAR_API_KEY ? { apiKey: process.env.FASTNEAR_API_KEY } : {}) });
const RELAYER_ID = process.env.RELAYER_ACCOUNT_ID!;                 // e.g. relayer.trellis.near (funded, small balance)
const relayerSigner = signerFromPrivateKey(process.env.RELAYER_PRIVATE_KEY!); // full-access key of the relayer

const ALLOWED_METHODS = new Set(["pause", "unpause", "revoke_agent", "set_policy"]);
const MAX_DEPOSIT = 1n;          // yoctoNEAR per action
const MAX_GAS = 50n * 10n ** 12n; // 50 Tgas per action

export async function POST(req: Request) {
  const session = await requireSession(req);                        // NEP-413 session → accountId (wallet.md)
  const { signedDelegate } = await req.json();

  let parsed;
  try { parsed = parseSignedDelegate(signedDelegate); } catch { return new Response("bad delegate", { status: 400 }); }
  const da = parsed.delegateAction;

  if (da.senderId !== session.accountId) return new Response("sender mismatch", { status: 403 });
  if (!(await isUsersVault(da.receiverId, da.senderId))) return new Response("receiver not allowed", { status: 403 });
  for (const a of da.actions) {
    if (a.type !== "FunctionCall") return new Response("only function calls", { status: 403 });
    if (!ALLOWED_METHODS.has(a.methodName)) return new Response("method not allowed", { status: 403 });
    if (BigInt(a.deposit ?? 0) > MAX_DEPOSIT) return new Response("deposit too high", { status: 403 });
    if (BigInt(a.gas ?? 0) > MAX_GAS) return new Response("gas too high", { status: 403 });
  }
  await rateLimit(da.senderId);                                     // e.g. 10 relays / hour / account

  const result = await near.relayDelegate({
    delegateAction: parsed.delegateAction,
    signature: parsed.signatureBytes,
    relayerSigner,
    relayerId: RELAYER_ID,
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
  return Response.json({ txHash: result?.transaction?.hash ?? result?.transaction_outcome?.id }); // [VERIFY] result shape
}
```
`isUsersVault` = check `receiverId` is the vault derived for `senderId` (factory naming rule) and its `get_policy`
owner equals the sender. `requireSession` / `rateLimit` are yours. `relayDelegate` also accepts
`{ signedDelegate, relayerSigner, relayerId }` directly (it calls `parseSignedDelegate` internally), but parse first
so you can validate. Amount fields (`gas`, `deposit`, `nonce`) come back as decimal strings ("NearInteger").

### Same thing with near-api-js only
- Server-held key (e.g. scripted test): `account.createSignedMetaTransaction({ receiverId, actions, blockHeightTtl })`
  → `{ delegateHash, signedDelegate }`, then relayer `relayerAccount.relayMetaTransaction(signedDelegate)`
  (it sends `actions.signedDelegate(...)` to `senderId`).
- Wallet base64 → near-api-js `SignedDelegate`: deserialize with `borsh.deserialize(SCHEMA.SignedDelegate, bytes)`
  (`SCHEMA` is exported) and rebuild `actions.signedDelegate({ delegateAction, signature })`. Untested round-trip
  of class instances → prefer `@fastnear/utils.parseSignedDelegate`. [VERIFY]

### Relayer ops checklist
- Separate relayer account with a small float (e.g. 5 NEAR); alert below 1 NEAR. Never reuse the agent account.
- Log `senderId`, `receiverId`, methods, tx hash per relay. Return the hash so the UI links NearBlocks.
- Expired delegates fail with `DelegateActionExpired`; nonce reuse with `DelegateActionInvalidNonce` → ask user to re-sign.
- Alternative without a relayer: gas keys (NEP-611, protocol ≥ 85; mainnet reports 86). Any account can fund a user's
  gas key with `TransferToGasKey`; signing is local only (`@fastnear/api` `sendTx` with `nonceIndex`), wallets need
  a `gasKeys` manifest feature not present in near-connect 0.11.4's manifest. Not for the browser path today.

## Part 2: data APIs

### FastNEAR REST (`https://api.fastnear.com`, testnet `https://test.api.fastnear.com`)
Public without key; `Authorization: Bearer <FASTNEAR_API_KEY>` for higher limits. Shapes verified live:

```ts
type FtRow = { contract_id: string; balance: string; last_update_block_height: number | null };
// GET /v1/account/{id}/ft   → { account_id, tokens: FtRow[] }
// GET /v1/account/{id}/full → { account_id, state: { balance, locked, storage_bytes }, tokens: FtRow[], nfts: [...], pools: [...] }
// GET /v1/account/{id}/nft | /staking
// GET /v1/public_key/{ed25519:...} → { public_key, account_ids: string[] }  (key → accounts; /all variant too)

export async function vaultHoldings(vaultId: string) {
  const r = await fetch(`https://api.fastnear.com/v1/account/${encodeURIComponent(vaultId)}/ft`, { next: { revalidate: 15 } });
  if (!r.ok) throw new Error(`fastnear ${r.status}`);
  const { tokens } = (await r.json()) as { tokens: FtRow[] };
  return tokens.filter((t) => t.balance !== "0");
}
```
Indexed balances lag chain head slightly (`last_update_block_height` may be null for old rows). For amounts the
vault logic or the guardian depends on, re-read `ft_balance_of` via RPC.
Via the SDK: `near.api.v1.accountFt({ accountId })`, `near.api.v1.accountFull({ accountId })`, `near.ft.balance(...)`.
Other FastNEAR families: `tx.main.fastnear.com` (indexed tx/receipts), `transfers.main.fastnear.com`, `mainnet.neardata.xyz` (blocks).

### NearBlocks (`https://api.nearblocks.io/v1`)
Verified live: `GET /account/{id}/txns-only?per_page=25&cursor=…` → `{ cursor, txns: [{ transaction_hash, signer_account_id,
receiver_account_id, block_timestamp, actions: [{ action, method, deposit, args }], outcomes: { status } }] }`;
`GET /account/{id}/receipts?per_page=…` → receipts with `predecessor_account_id`, `receipt_outcome.status`;
`GET /account/{id}/txns-only/count` → `{ txns: [{ count }] }`; `GET /stats` → `{ stats: [{ near_price, gas_price, ... }] }`.
- Free tier works without a key but is tightly rate-limited; paid key via `Authorization: Bearer`. Exact limits [VERIFY]
  on nearblocks.io/apis. `GET /fts/{contract}` returned a Server Error on 2026-10-22, don't depend on it.
- Use for the Trellis activity feed (vault receipts history, user's deposits). Cache in a route handler (CORS + rate limit).
- Explorer links: `https://nearblocks.io/txns/{hash}`, `https://nearblocks.io/address/{account}`.

### Token prices (USD)
| Source | Endpoint | Notes (verified 2026-10-22) |
|---|---|---|
| Ref indexer | `GET https://indexer.ref.finance/list-token-price` | map `{ [tokenId]: { price: string, symbol, decimal } }`, ~4.2k tokens; wNEAR 5.37, USDC 0.9997 |
| 1Click | `GET https://1click.chaindefuser.com/v0/tokens` | array `{ assetId: "nep141:…", contractAddress, symbol, decimals, price: number, priceUpdatedAt }` (multi-chain) |
| NearBlocks | `GET /v1/stats` | NEAR price only |
| On-chain | `aggregate-oracle.near` | what the vault/Burrow use for HF; see `rhea-burrow-lending` |

Display prices may come from Ref/1Click; **anything that gates money (HF, slippage, guardian) must use the same oracle
the vault uses**, not these APIs.

### `.near` account validation

```ts
import { provider } from "@/lib/near/provider"; // FailoverRpcProvider (near-api-js.md)
// nearcore rules: 2–64 chars, lowercase a-z 0-9, separators - _ . ; no leading/trailing/double separators.
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isValidAccountId = (id: string) => id.length >= 2 && id.length <= 64 && ACCOUNT_RE.test(id);
export const isImplicit = (id: string) => /^[0-9a-f]{64}$/.test(id);      // ed25519 implicit
export const isEthImplicit = (id: string) => /^0x[0-9a-f]{40}$/.test(id);  // NEP-518 eth-implicit

export async function accountExists(id: string) {
  try { await provider.viewAccount({ accountId: id }); return true; }
  catch (e) { if ((e as Error).name === "AccountDoesNotExistError" || /does not exist/i.test(String(e))) return false; throw e; }
}
```
- `.near` top-level names are registered via the `near` registrar; subaccounts (`x.trellis.near`) can only be
  created by the parent. A valid-looking id may not exist: always check before sending tokens there.
- Vault naming (from vault-spec): `alice.near` → `alice-near.trellis.near`; full id must stay ≤ 64 chars.
- Sending FTs to an account requires NEP-145 storage registration on that token (`storage_balance_of`).
- Replace Sprout's SuiNS resolution with this (no reverse lookup needed: the account id is the name).

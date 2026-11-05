---
name: near-frontend
description: NEAR app-side integration for Trellis (Next.js App Router + React + server routes). Covers wallet connection with NEAR Connect (@hot-labs/near-connect, near-connect-hooks), signAndSendTransaction(s) with FunctionCall actions (gas/deposit), NEP-413 signMessage + server-side verification, near-api-js v7 (Account, JsonRpcProvider, FailoverRpcProvider, KeyPairSigner, actions) for view calls / server signing / tx outcome + NEP-297 event parsing, NEP-366 meta transactions and relayers, FastNEAR RPC/API, NearBlocks API, token prices and .near account validation. Use when touching wallet code, building or sending NEAR transactions from the browser or a Node/Next route, verifying a wallet signature, reading balances/history, or choosing RPC endpoints. Triggers: NEAR Connect, near-connect, wallet selector, near-api-js, signAndSendTransactions, signMessage, NEP-413, meta transaction, relayer, FastNEAR, NearBlocks.
---

# NEAR frontend + app plumbing (Trellis)

Researched 2026-10-22 against the npm tarballs and live endpoints listed under Sources.
Scope: the web app (`../sprout/web` port) and any Node code that talks to NEAR RPC.
Out of scope (other skills): vault contract code (`near-rust-contracts`), sandbox tests
(`near-contract-testing`), Burrow/Rhea call shapes (`rhea-burrow-lending`), Ref swaps
(`ref-dex-swaps`), 1Click/Intents (`near-intents`), the agent worker + NEAR AI (`near-ai-agent-infra`).

## Package choices (pin these)

| Need | Package | Version verified | Notes |
|---|---|---|---|
| Wallet connector | `@hot-labs/near-connect` | **0.11.4** (npm latest) | Successor of near-wallet-selector. Wallet code runs in sandboxed iframes, loaded from a remote manifest. |
| React hooks (optional) | `near-connect-hooks` | **1.1.6** | `NearProvider` + `useNearWallet()`. Depends on near-api-js ^7 and near-connect ^0.11.1. **Defaults to testnet** and ships **no `"use client"`**. |
| RPC, signing, tx building | `near-api-js` | **7.3.1** | Single package now; replaces `@near-js/*` (last 2.5.1, Nov 2025) and the v4/v5 `connect()/keyStores/WalletConnection` API. Subpaths: `near-api-js/nep413`, `near-api-js/tokens`, `near-api-js/tokens/mainnet`. |
| Meta-tx relay, gas keys, FastNEAR REST | `@fastnear/api` | **2.5.0** (+ `@fastnear/utils` 2.5.0) | `relayDelegate`, `parseSignedDelegate`, `sendTx` (gas keys / TransactionV1), `api.v1.accountFull/accountFt`. |
| WalletConnect wallets (optional) | `@walletconnect/sign-client` | not pinned | Without it, WalletConnect-permission wallets are silently dropped from the list. |

Trellis's current stack: Next 16.2.6, React 19.2.4, `ai` ^6. Nothing above conflicts.

## Mental model

```
Browser (client component)                    Next route handlers / worker (Node)
 NearConnector ── wallet iframe ── user        JsonRpcProvider/FailoverRpcProvider (FastNEAR first)
   connect()  → accountId                       provider.callFunction()  view calls
   signMessage (NEP-413) ───────────────────▶   verifyMessage() → session cookie
   signAndSendTransaction(s) → FinalExecutionOutcome (wallet broadcasts)
   signDelegateActions → base64 SignedDelegate ▶ /api/relay → relayDelegate (relayer pays gas)
```

User-signed actions (create vault, deposit, set_policy, withdraw, revoke_agent) go through the wallet.
Agent actions are signed server-side by `agent.trellis.near` function-call keys (see `near-ai-agent-infra`).

## Common mistakes (all seen in real code / docs)

1. **Using `@near-wallet-selector/*`** (`setupWalletSelector`, `setupModal`). Deprecated path; use `NearConnector`. The two APIs are not compatible.
2. **Using near-api-js v4/v5 APIs**: `connect()`, `keyStores.*`, `WalletConnection`, `new Contract(account, id, {viewMethods})`, `account.functionCall({...})`, `account.viewFunction`, `utils.format.parseNearAmount`. In v7: `new Account(id, provider, signer)`, `provider.callFunction({contractId, method, args})`, `account.callFunction({contractId, methodName, args, gas, deposit})`, `nearToYocto()`, `teraToGas()`.
3. **Mixed arg names**: provider uses `method`, account uses `methodName`. Easy to swap.
4. **Hard-coding `rpc.mainnet.near.org`** (rate-limited; NEAR docs list only third-party providers). Use FastNEAR (`https://free.rpc.fastnear.com`, or `https://rpc.mainnet.fastnear.com?apiKey=…`) behind `FailoverRpcProvider`. `near.lava.build` returned **HTTP 410** on 2026-10-22, drop it from old configs.
5. **near-connect-hooks network default is `testnet`**. Always pass `config={{ network: "mainnet" }}`.
6. **Constructing `NearConnector` during SSR / in a server component.** Keep it in a `"use client"` module, create it in an effect or via `dynamic(..., { ssr: false })`.
7. **Calling `connect()` before the manifest loads.** `await connector.whenManifestLoaded` (connect does this internally, but `availableWallets` is empty until then).
8. **FunctionCall without `gas`/`deposit` strings** in ConnectorAction format. Both are yoctogas / yoctoNEAR **strings**: `gas: "30000000000000"`, `deposit: "1"`.
9. **Forgetting 1 yocto** on owner methods (`assert_one_yocto`) and on `ft_transfer` / `ft_transfer_call`.
10. **Treating `signMessage` signature as hex/base58.** Wallets return **base64**; `verifyMessage` wants `Uint8Array`.
11. **Trusting the client's accountId.** Verify NEP-413 server-side, check the key is a FullAccess key of that account (near-api-js does), check `recipient` + single-use `nonce`.
12. **Only checking `status.SuccessValue` of the tx.** A tx can succeed while a later receipt (callback, `ft_transfer_call` refund) fails. Walk `receipts_outcome`.
13. **Relaying any delegate the client sends.** The relayer pays gas **and attached deposits** of inner actions. Allowlist receiver + methods, cap deposit.
14. Assuming testnet parity: Intents has no testnet, Burrow testnet is stale (see research doc). Wallet `testnet` feature flag also filters many wallets out.

## Reference index

- [wallet.md](wallet.md): NEAR Connect in Next.js App Router, connect/disconnect, accountId, signAndSendTransaction(s) for Trellis vault calls, NEP-413 sign-in + server verification, wallet feature matrix (signDelegateActions support).
- [near-api-js.md](near-api-js.md): near-api-js v7 server-side: providers + failover, view calls, account state, FT balances, sending txs from a server key, tx status/outcome parsing, NEP-297 `EVENT_JSON` logs, nonce behaviour.
- [gasless-and-data.md](gasless-and-data.md): NEP-366 meta transactions (wallet-signed delegate → Next.js relay route), relayer guardrails, gas keys pointer; FastNEAR REST, NearBlocks API, token prices, `.near` account validation.

## Sources (fetched 2026-10-22)

- npm tarballs: `@hot-labs/near-connect@0.11.4` (README, `skills/`, `build/*.d.ts`, `build/NearConnector.js`), `near-connect-hooks@1.1.6` (`dist/useNearWallet.js`), `near-api-js@7.3.1` (`lib/*.d.ts`, `lib/index.js`, `lib/nep413`), `@fastnear/api@2.5.0`, `@fastnear/utils@2.5.0`.
- github.com/hot-dao/near-selector (manifest `repository/manifest.json`, example `example/src/wallet-action/SendTx.tsx`); wallet executors (ledger, intear) for delegate encoding.
- docs.near.org/api/rpc/providers, docs.near.org/protocol/transactions/meta-tx.
- js.fastnear.com/meta-transactions.html, js.fastnear.com/gas-keys.html.
- Live probes: FastNEAR RPC `status` (protocol_version 86, nearcore 2.13.4), `api.fastnear.com/v1/account/*/full|ft`, `api.nearblocks.io/v1/account/*/txns-only|receipts`, `indexer.ref.finance/list-token-price`.

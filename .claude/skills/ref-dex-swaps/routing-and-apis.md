# Routing, price APIs and TypeScript (frontend / user wallet / off-chain worker)

Checked 2026-10-22. **Everything in this file is off-chain. Never let the vault trust it.**
- The vault computes `min_out` from `aggregate-oracle.near` and swaps only through allowlisted Ref v2 pool ids (see `classic-pools.md`).
- Router output and indexer prices are fine for UI quotes, for picking which pool id to allowlist, and for the agent's planning.

## 1. Rhea Smart Router V2 / Aggregated DEX (`aggregatedex.near`)

Official doc: `rhea-finance/rhea-sdk-docs` → `SmartRouterV2(Aggregated DEX).md`. Routes across Ref v2 AMM/stable pools, CLMM (DCL), "ALMM" and others.

**Quote / build:** `GET https://smartx.rhea.finance/swapMultiDexPath`
- Query params: `amountIn` (smallest unit), `tokenIn`, `tokenOut`, `slippage` (0.005 = 0.5%).
- Optional: `user` (required before execution), `receiveUser`, `skipUnwrapNativeToken`, `appFeeRate` (per-mille ×10: `10` = 0.1%, max 1000) + `appFeeRecipient` (send both or neither; 20% of the app fee goes to Rhea).

Live response (100 wNEAR → USDC, no `user`):
```json
{"result_code":0,"result_message":"","result_data":{
  "amount_in":"100000000000000000000000000","amount_out":"534419022","min_amount_out":"531746926",
  "dexs":["RheaCLMM"],
  "msg":"gil8emx5KUEp…(opaque, obfuscated blob)…","signature":"992edba7…(64-byte hex)",
  "tokens":["wrap.near","17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"]}}
```
The official doc shows the inner object without the `result_code/result_data` envelope. The live API wraps it.

**Execute (user wallet only):**
```
tokenIn.ft_transfer_call({receiver_id: "aggregatedex.near", amount: amount_in,
                          msg: JSON.stringify({msg: result_data.msg, signature: result_data.signature})})
deposit 1 yocto, gas 300 Tgas ("Gas required: == 300 Tgas")
```
Prerequisites:
- Register every token in `tokens`, for the `user` (and the fee recipient), on the aggregator: check with `aggregatedex.near.query_user_tokens_registered({user, tokens}) -> [bool]` (live), register with `tokens_storage_deposit({user, tokens})` (0.005 NEAR per token per the doc).
- Also register them on each token contract for the user and for `aggregatedex.near`.

Recovery:
- Stuck balances: `query_user_exist_balance({user, from_index, count})`.
- Withdraw: `withdraw({token, return_near})`.

**Why not inside the vault:** the route is an opaque server-signed blob. The vault can't check which pools or tokens it touches, and the output reaches the user through the aggregator's own internal balance logic. That is exactly the fake-token/multi-hop surface behind the April 2026 exploit.

**Legacy Ref router (AMM-only, returns readable pool ids, useful for choosing allowlist ids):**
`GET https://smartrouter.ref.finance/findPath?amountIn=…&tokenIn=…&tokenOut=…&pathDeep=3&slippage=0.005`. Live:
```json
{"result_code":0,"result_message":"","result_data":{"routes":[{"pools":[{"pool_id":"6063","token_in":"wrap.near",
 "token_out":"usdt.tether-token.near","amount_in":"1000000000000000000000000","amount_out":"0","min_amount_out":"5326821"}],
 "amount_in":"…","min_amount_out":"5326821","amount_out":"0"}],"contract_in":"wrap.near","contract_out":"usdt.tether-token.near",
 "amount_in":"1000000000000000000000000","amount_out":"5353589"}}
```
Per-pool `amount_out` came back `"0"`. Use the top-level `amount_out`. The route can be turned into a Ref v2 `Execute` msg (see `classic-pools.md` §3). This endpoint isn't in the current official docs. **[VERIFY stability]**

**Cross-chain DEX API** (`https://api.rhea.finance/api/v2/swap/quote|swap`, Bearer API key from boss.rhea.finance) and the npm packages `@rhea-finance/cross-chain-aggregation-dex` 2.1.9 / `@rhea-finance/crosschain-sdk` 0.1.6 are cross-chain products. Out of scope here. **[VERIFY if needed]**

## 2. Price and token APIs (off-chain, UI only)

| Endpoint | Live shape (2026-10-22) |
|---|---|
| `GET https://indexer.ref.finance/list-token-price` | `{ "<token_id>": {"price":"5.37","symbol":"wNEAR","decimal":24}, … }`, 4,234 tokens. USDC `0.999713`, USDt `0.999505` |
| `GET https://api.ref.finance/list-token-price` | same shape (also live) |
| `GET https://indexer.ref.finance/list-token` | `{ "<token_id>": {spec,name,symbol,icon,reference,reference_hash,decimals} }`, which includes junk tokens like `0.token0.near` |
| `list-token-v2` | used by the SDK (`src/indexer.ts`). **[VERIFY shape]** |

Rules:
- Prices are strings; parse them with a decimal library, not `Number` (some have 100+ digits).
- The token list is **not** a safety list: anyone can create a token with symbol "USDC". Identify tokens **by account id only**:
  - wNEAR `wrap.near`
  - native USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
  - USDT `usdt.tether-token.near`
  - bridged USDC.e `a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near`
  - bridged USDT.e `dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near`
- Ref's own `get_whitelisted_tokens` (212 ids) is a better "known token" filter than the indexer list.
- On-chain truth for the vault: `aggregate-oracle.near` (vault-spec §8).

## 3. SDK status (npm, 2026-10-22)

| Package | Latest | Notes |
|---|---|---|
| `near-api-js` | **7.3.1** (2026-08-12) | single package; `Account`, `JsonRpcProvider`, `actions`, `teraToGas`, `nearToYocto` |
| `@hot-labs/near-connect` | **0.11.4** | wallet connector; `wallet.signAndSendTransactions({transactions:[{receiverId, actions:[{type:"FunctionCall", params:{methodName,args,gas,deposit}}]}]})` |
| `@ref-finance/ref-sdk` | 1.5.0 (2026-02-01) | GitHub `ref-finance/ref-sdk` and `rhea-finance/rhea-sdk` publish the same package name. **It depends on `near-api-js` 0.44.2 and `@near-wallet-selector/core` ^7 (legacy)**, and mainnet uses `rpc.mainnet.near.org` by default. Don't add it to a v7 app. Copy the msg shapes instead (`src/v1-swap/instantSwap`, `src/dcl-swap/swap.ts`) |
| `@rhea-finance/rhea-sdk` | not on npm | |

## 4. TypeScript (near-api-js 7.3.1): quote + user-wallet swap

Not compiled here **[VERIFY: tsc + one small mainnet swap]**. The JSON shapes are verified against live RPC and mainnet txs.

```ts
import { JsonRpcProvider, Account, actions, teraToGas } from "near-api-js";

const RPC = "https://rpc.mainnet.fastnear.com";
const REF = "v2.ref-finance.near";
const DCL = "dclv2.ref-labs.near";
const WNEAR = "wrap.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const provider = new JsonRpcProvider({ url: RPC });

// ---- Quotes (views) ----
type PoolInfo = { pool_kind: string; token_account_ids: string[]; amounts: string[]; total_fee: number; shares_total_supply: string; amp: number };

async function quoteRefPool(poolId: number, tokenIn: string, tokenOut: string, amountIn: string) {
  const pool = await provider.callFunction<PoolInfo>({ contractId: REF, method: "get_pool", args: { pool_id: poolId } });
  if (!pool || !pool.token_account_ids.includes(tokenIn) || !pool.token_account_ids.includes(tokenOut)) throw new Error("pool/token mismatch");
  const out = await provider.callFunction<string>({
    contractId: REF, method: "get_return",
    args: { pool_id: poolId, token_in: tokenIn, amount_in: amountIn, token_out: tokenOut },
  });
  return BigInt(out!);
}

function dclPoolId(a: string, b: string, fee: 100 | 400 | 2000 | 10000) {
  return [a, b].sort().join("|") + "|" + fee;
}
async function quoteDcl(tokenIn: string, tokenOut: string, amountIn: string, fee: 100 | 400 | 2000 | 10000 = 100) {
  const r = await provider.callFunction<{ amount: string; tag: string | null }>({
    contractId: DCL, method: "quote",
    args: { pool_ids: [dclPoolId(tokenIn, tokenOut, fee)], input_token: tokenIn, output_token: tokenOut, input_amount: amountIn },
  });
  return BigInt(r?.amount ?? "0"); // "0" ⇒ pool can't fill
}

const applySlippage = (x: bigint, bps: bigint) => (x * (10_000n - bps)) / 10_000n;

// ---- Build the user-wallet transactions (near-connect / wallet format) ----
async function buildRefInstantSwap(user: string, poolId: number, tokenIn: string, tokenOut: string, amountIn: string, slippageBps = 50n) {
  const minOut = applySlippage(await quoteRefPool(poolId, tokenIn, tokenOut, amountIn), slippageBps);
  const txs: any[] = [];
  // user must be registered on token_out to receive it
  const reg = await provider.callFunction({ contractId: tokenOut, method: "storage_balance_of", args: { account_id: user } });
  if (reg === null) txs.push({ receiverId: tokenOut, actions: [{ type: "FunctionCall", params: {
      methodName: "storage_deposit", args: { account_id: user, registration_only: true },
      gas: teraToGas("30").toString(), deposit: "1250000000000000000000" } }] }); // 0.00125 NEAR, the amount the traced DCL tx attached for wrap.near; use storage_balance_bounds().min per token [VERIFY]
  const msg = JSON.stringify({
    actions: [{ pool_id: poolId, token_in: tokenIn, token_out: tokenOut, amount_in: amountIn, min_amount_out: minOut.toString() }],
    skip_unwrap_near: true,
  });
  txs.push({ receiverId: tokenIn, actions: [{ type: "FunctionCall", params: {
      methodName: "ft_transfer_call", args: { receiver_id: REF, amount: amountIn, msg },
      gas: teraToGas("180").toString(), deposit: "1" } }] });
  return txs; // → (await connector.wallet()).signAndSendTransactions({ transactions: txs })
}

async function buildDclSwap(tokenIn: string, tokenOut: string, amountIn: string, fee: 100 | 400 | 2000 | 10000 = 100, slippageBps = 50n) {
  const q = await quoteDcl(tokenIn, tokenOut, amountIn, fee);
  if (q === 0n) throw new Error("DCL pool cannot fill");
  const msg = JSON.stringify({ Swap: {
    pool_ids: [dclPoolId(tokenIn, tokenOut, fee)], output_token: tokenOut,
    min_output_amount: applySlippage(q, slippageBps).toString(), skip_unwrap_near: true } });
  return [{ receiverId: tokenIn, actions: [{ type: "FunctionCall", params: {
      methodName: "ft_transfer_call", args: { receiver_id: DCL, amount: amountIn, msg },
      gas: teraToGas("180").toString(), deposit: "1" } }] }];
}

// ---- If the input is native NEAR: wrap first (same tx as the swap's ft_transfer_call) ----
// { receiverId: "wrap.near", actions: [ {type:"FunctionCall", params:{methodName:"near_deposit", args:{}, gas: teraToGas("10").toString(), deposit: amountIn}},
//                                       {type:"FunctionCall", params:{methodName:"ft_transfer_call", args:{receiver_id: REF, amount: amountIn, msg}, gas: teraToGas("150").toString(), deposit:"1"}} ] }
// (the traced DCL tx did exactly storage_deposit + near_deposit + ft_transfer_call in one tx to wrap.near)

// ---- Server-side signer (worker / scripts), near-api-js v7 ----
async function serverSwap(accountId: string, privateKey: `ed25519:${string}`, txs: { receiverId: string; actions: any[] }[]) {
  const account = new Account(accountId, provider, privateKey);
  for (const t of txs) {
    await account.signAndSendTransaction({
      receiverId: t.receiverId,
      actions: t.actions.map((a) => actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit))),
    });
  }
}
```

Notes:
- The agent's own swaps go **through the vault** (`agent_swap_ref`), never through these wallet transactions. The agent key can only call `agent_*`.
- Reading the actual output of a wallet instant-swap: it is only in logs, as a Ref `Swapped X a for Y b` text log in the pool receipt or a DCL `EVENT_JSON` with `event: "swap"`. Or diff `ft_balance_of`. `getTransactionLastResult` gives `ft_transfer_call`'s used amount, not the output.
- Fetch decimals with `ft_metadata`: wNEAR 24, USDC/USDT 6.

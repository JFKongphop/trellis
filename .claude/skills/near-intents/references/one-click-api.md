# 1Click Swap API reference

- **Base URL:** `https://1click.chaindefuser.com`. All routes are under `/v0`. OpenAPI: `https://1click.chaindefuser.com/docs/v0/openapi.yaml` (`info.version` 0.1.10, fetched 2026-10-21).
- **No testnet.** Use `dry: true` for previews. `dry: false` creates a real deposit address.
- **TS SDK:** `@defuse-protocol/one-click-sdk-typescript` **0.1.26** (npm, modified 2026-09-22). `verifyQuoteSignature` needs ≥ 0.1.24. Go: `defuse-protocol/one-click-sdk-go`. Rust: `defuse-protocol/one-click-sdk-rs` (clone it as a path dependency, per the docs).

## 1. Authentication

| Scheme (OpenAPI `securitySchemes`) | Header | Use |
|---|---|---|
| `X-API-Key` (recommended) | `X-API-Key: <partner JWT>` | partner auth on `/quote`, `/status`, `/deposit/submit`, `/generate-intent`, `/submit-intent`, `/any-input/withdrawals`, `/orders*` |
| `JWT-auth` (legacy) | `Authorization: Bearer <partner JWT>` | same token, older header |
| `User-Session` | `Authorization: Bearer <accessToken>` | only `/v0/account/balances` (and history) for Confidential Intents. Obtained via `/v0/auth/authenticate` (wallet-signed empty intent) and `/v0/auth/refresh` |

- **How to get a partner JWT:** Partner Dashboard https://partners.near-intents.org/ ("Get your JWT token from the Partner Dashboard"). The SDK README still links an older Google Form.
- **Without a key** the calls still work. We got live quotes with no header. Docs (`resources/fees`): "Additional **0.25% (25 bps)** on every non-`ANY_INPUT` quote. Submitted `appFees` are kept, and 25 bps is added on top." With a key and no `appFees`: **20 bps**, or **1 bp** for stablecoin pairs and same-asset multichain routes. On top of this is the on-chain protocol fee of 1 pip (0.0001%).
  - *Observed:* unauthenticated live responses echo `quoteRequest.appFees = [{"recipient":"5880ad2b…47dd","fee":20}]` (`fee: 1` on a USDC→USDC route). That matches the 20/1 bps schedule, so how the extra 25 bps is applied is not visible in the response. **[VERIFY with a key]**
- SDK config: `OpenAPI.BASE` (default as above), `OpenAPI.TOKEN = '<jwt>'` sends `Authorization: Bearer`. To use `X-API-Key`, set `OpenAPI.HEADERS = {'X-API-Key': jwt}`.

## 2. Endpoints

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /v0/tokens[?ondoTokens=…]` | none | List of `TokenResponse {assetId, decimals, blockchain, symbol, price, priceUpdatedAt, contractAddress?, coingeckoId?}` (205 entries live) |
| `POST /v0/quote` | key/JWT (optional; fee) | `QuoteRequest` → `QuoteResponse` (HTTP **201** observed). 400 `{message}` on bad input. |
| `GET /v0/status?depositAddress=&depositMemo=` | key/JWT | `GetExecutionStatusResponse`. 404 `{"message":"Deposit address … not found","error":"Not Found","statusCode":404,…}` |
| `POST /v0/deposit/submit` | key/JWT | `{txHash, depositAddress, nearSenderAccount?, memo?}` → same shape as status. Optional speed-up for `ORIGIN_CHAIN`. |
| `POST /v0/generate-intent` | key/JWT | `{type:"swap_transfer", standard:"nep413"\|"erc191"\|"raw_ed25519"\|"webauthn"\|"ton_connect"\|"sep53"\|"tip191", signerId, depositAddress}` → `{intent: <unsigned MultiPayload>, correlationId}` |
| `POST /v0/submit-intent` | key/JWT | `{type:"swap_transfer", signedData: <MultiPayload with public_key + signature>}` → `{intentHash, correlationId}` |
| `GET /v0/any-input/withdrawals?depositAddress=&…` | key/JWT | Payouts of an `ANY_INPUT` collector (partners only) |
| `POST/GET /v0/orders`, `GET /v0/orders/{id}`, `POST /v0/orders/{id}/cancel` | key/JWT | Confidential **limit orders** (JSON:API, `application/vnd.api+json`). Funded by signed intent. Not usable from a key-less contract. |
| `POST /v0/auth/authenticate`, `POST /v0/auth/refresh`, `GET /v0/account/balances`, `GET /v0/account/history` | user session | Confidential Intents user data. History is invite-only (403). |

Status enum: `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED`, `FAILED`. `swapDetails`: `intentHashes[]`, `nearTxHashes[]`, `amountIn*`, `amountOut*`, `slippage`, `originChainTxHashes[{hash,explorerUrl}]`, `destinationChainTxHashes[]`, `refundedAmount*`, `refundReason` (e.g. `PARTIAL_DEPOSIT`), `depositedAmount*`, `withdrawFee`, `referral`. The explorer is https://explorer.near-intents.org.

## 3. `QuoteRequest`: every field

Required: `dry, swapType, slippageTolerance, originAsset, depositType, destinationAsset, amount, refundTo, refundType, recipient, recipientType, deadline`.

| Field | Type / enum | Notes |
|---|---|---|
| `dry` | bool | `true` → no `depositAddress`, `timeWhenInactive`, or quote `deadline` |
| `swapType` | `EXACT_INPUT` \| `EXACT_OUTPUT` \| `FLEX_INPUT` \| `ANY_INPUT` | EXACT_INPUT: deposit < `amountIn` is refunded by the deadline; excess is refunded after the swap. EXACT_OUTPUT: slippage on the input side; `amountIn` > `minAmountIn` (buffer refunded). FLEX_INPUT: band `minAmountIn..`, any amount ≥ min is swapped (no confidential). ANY_INPUT: partners only, `originAsset:"1cs_v1:any"`, `amount:"0"`, sweeps at ≥ $1,000, **no refunds**. |
| `slippageTolerance` | number, **bps** | 100 = 1% |
| `originAsset` / `destinationAsset` | asset id string | from `/v0/tokens` |
| `amount` | integer string, base units | interpreted per `swapType` |
| `depositType` | `ORIGIN_CHAIN` \| `INTENTS` \| `CONFIDENTIAL_INTENTS` | INTENTS = "the account ID within NEAR Intents to which you should transfer assets" |
| `refundTo` / `refundType` | string / `ORIGIN_CHAIN` \| `INTENTS` \| `CONFIDENTIAL_INTENTS` | |
| `recipient` / `recipientType` | string / `DESTINATION_CHAIN` \| `INTENTS` \| `CONFIDENTIAL_INTENTS` | the format must match the type |
| `deadline` | ISO date-time | when refunds begin. Must cover origin-chain confirmation time (BTC ~1 h). Echoed normalized (`…:18Z` → `…:18.000Z`). |
| `depositMode` | `SIMPLE` (default) \| `MEMO` | MEMO needed on some chains (Stellar). Response has `depositMemo`. |
| `quoteWaitingTimeMs` | number, default 0 | wait for more solver quotes |
| `confidentiality` | `public` (default) \| `basic` \| `advanced` | confidential swap (added 2026-07-01) |
| `appFees` | `[{recipient: <Intents account>, fee: <bps>}]` | partner fees, taken from `amountIn` |
| `referral` | string | lowercase channel id |
| `rebates` | `[{recipient, share%}]` ≤ 3, sum 100 | confidential recipients |
| `insured` | bool | +2 bps insurance |
| `connectedWallets`, `sessionId` | string[], string | analytics |
| `virtualChainRecipient`, `virtualChainRefundRecipient` | EVM address | virtual chains |
| `customRecipientMsg` | string | **HIGHLY EXPERIMENTAL**: 1Click withdraws to NEAR with `ft_transfer_call(msg)`. "Funds will be lost" if storage or `ft_on_transfer` is missing. Don't use. |

`Quote` (response): `amountIn, amountInFormatted, amountInUsd, minAmountIn, amountOut, amountOutFormatted, amountOutUsd, minAmountOut, timeEstimate` (s, required), plus `depositAddress`, `depositMemo`, `deadline` ("deposit address becomes inactive and funds may be lost"), `timeWhenInactive` ("becomes cold"), `refundFee`, `withdrawFee` (already netted in `amountOut`), `chainDepositAddresses[{blockchain,address,memo?}]` (public ANY_INPUT only), `virtualChain*`, `customRecipientMsg`.

`QuoteResponse`: `{correlationId, timestamp, signature, quoteRequest, quote}`. The docs say the signature "Must be saved on the client side (along with the whole quote) in order to resolve any disputes".

## 4. Asset ID formats (live `/v0/tokens`: 144 `nep141:`, 36 `nep245:`, 25 `1cs_v1:`)

- `nep141:<near ft account>`. NEAR-native: `nep141:wrap.near`, `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC). POA-bridged: `nep141:btc.omft.near`, `nep141:eth-0xa0b8…eb48.omft.near`. Omni: `nep141:nbtc.bridge.near`, `nep141:eth.bridge.near`. Some newer ones use `*.omdep.near`.
- `nep245:<mt contract>:<id>`: HOT bridge, e.g. `nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L` (USDC on Polygon).
- `1cs_v1:<chain>:<standard>:<address>`, e.g. `1cs_v1:btc:native:coin`, `1cs_v1:sol:spl:<mint>`, `1cs_v1:near:nep141:zec.omft.near`, `1cs_v1:any`. These are 1Click routing IDs for assets that aren't held as plain Intents tokens (grammar inferred from samples **[VERIFY]**).
- **Normalization:** a live dry quote with `originAsset:"nep141:btc.omft.near"` + `ORIGIN_CHAIN` came back (and was signed) as `"1cs_v1:btc:native:coin"`. With `depositType:"INTENTS"` the same asset stayed `nep141:btc.omft.near`. A vault must compare the **signed** value against its allowlist literally.

## 5. Live examples (dry, no API key, 2026-10-21)

Request: 5 USDC (NEAR) → wNEAR, entirely inside Intents (the vault-routing shape):

```json
{"dry":true,"swapType":"EXACT_INPUT","slippageTolerance":100,
 "originAsset":"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","depositType":"INTENTS",
 "destinationAsset":"nep141:wrap.near","amount":"5000000",
 "refundTo":"sprout-demo.near","refundType":"INTENTS","recipient":"sprout-demo.near","recipientType":"INTENTS",
 "deadline":"2026-10-21T18:20:18Z","quoteWaitingTimeMs":3000}
```

Response (HTTP 201):

```json
{"quote":{"amountIn":"5000000","amountInFormatted":"5.0","amountInUsd":"4.998500000000","minAmountIn":"5000000",
  "amountOut":"931129435042566502055987","amountOutFormatted":"0.931129435042566502055987","amountOutUsd":"4.981542477478",
  "minAmountOut":"921818140692140837035427","timeEstimate":10,"refundFee":"0","withdrawFee":"0"},
 "quoteRequest":{"dry":true,"depositMode":"SIMPLE","swapType":"EXACT_INPUT","slippageTolerance":100,
  "originAsset":"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","depositType":"INTENTS",
  "destinationAsset":"nep141:wrap.near","amount":"5000000","refundTo":"sprout-demo.near","refundType":"INTENTS",
  "recipient":"sprout-demo.near","recipientType":"INTENTS","deadline":"2026-10-21T18:20:18.000Z",
  "confidentiality":"public","quoteWaitingTimeMs":3000,"insured":false,
  "appFees":[{"recipient":"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd","fee":20}]},
 "signature":"ed25519:nrEjMvMjZcpQn5iqFhWBw5utCFr7eDGTKJ1ynRdK3cUs2vXtDnszU9SJKfHF9AnQ6KWJKZxNQbiMT5p8c5ucrar",
 "timestamp":"2026-10-21T18:10:18.355Z","correlationId":"378c1e04-b973-4a93-9b26-b38e376a8202"}
```

Other observations from the same session:
- BTC (origin chain) → USDC on NEAR to an existing account: `timeEstimate: 805`, `refundFee: "1900"` sats, `originAsset` echoed as `1cs_v1:btc:native:coin`.
- Base USDC (`ORIGIN_CHAIN`) → NEAR USDC with `recipientType: INTENTS`, `recipient: "sprout-demo.near"` (a non-existent account is fine inside Intents): `timeEstimate: 35`, `refundFee: "2400"`.
- Same but `recipientType: DESTINATION_CHAIN` to the **non-existent** `sprout-demo.near`: HTTP 400 `{"message":"Internal server error",…}`. With `v2.ref-finance.near` it worked. So for NEAR delivery, the recipient account must exist (and probably be storage-registered **[VERIFY]**).
- NEAR USDC → Earn `gtUSDCp` (Base Morpho receipt) with `INTENTS`/`INTENTS`: `timeEstimate: 25`.
- Temporary minimums (changelog): origin→origin swaps under $1,000 are blocked on BSC, Polygon, TON, Optimism, Avalanche, Stellar, Monad, XLayer and ADI (2026-09-09), and under $100 when depositing from Tron (2026-09-14). Deposits to and withdrawals from Intents are not affected.

## 6. Quote signature: what is signed and where the key is (RESOLVED)

Source: SDK 0.1.26 `dist/index.mjs`, section `// src/quote-signature.ts`, and docs page `integration/distribution-channels/1click-api/verify-quote-signature` (changelog 2026-06-27). It was **verified three ways** (SDK `verifyQuoteSignature`, independent Python, Rust/near-sdk unit test) against three live dry quotes. A tampered `recipient` fails.

**Public key** (hard-coded in the SDK as `ONE_CLICK_MANAGER_PUB_KEY`; the docs page doesn't print it):

```
ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc
```

`verifyQuoteSignature(response, managerPublicKey = ONE_CLICK_MANAGER_PUB_KEY)` takes an override. Store the key in vault policy (owner-settable) so a rotation doesn't need a redeploy. No rotation or announcement channel was found. **[VERIFY with the 1Click team]**

**Signed message** = UTF-8 bytes of `base58( sha256( json_stable_stringify(obj) ) )`, where:

```js
obj = { ...signedRequest, ...signedQuote, timestamp: response.timestamp }   // later keys win
signedRequest = {           // from response.quoteRequest
  dry, swapType, slippageTolerance, originAsset, depositType, destinationAsset, amount,
  refundTo, refundType, recipient, recipientType, deadline,
  quoteWaitingTimeMs  /* only if truthy */, referral /* if truthy */,
  virtualChainRecipient, virtualChainRefundRecipient, customRecipientMsg /* if truthy */,
  // explicitly NOT signed: sessionId, connectedWallets, correlationId, appFees, partnerId,
  //                        userAccountId, depositMode  (and confidentiality, insured, rebates are not listed)
}
signedQuote = dry
  ? { amountIn, amountInFormatted, amountInUsd, minAmountIn, amountOut, amountOutFormatted, amountOutUsd, minAmountOut }
  : { …same 8…, depositAddress, depositMemo, deadline, timeWhenInactive, timeEstimate, refundFee, withdrawFee }
      // each `x || undefined`; undefined keys are dropped by json-stable-stringify
```

- `json-stable-stringify@1.3.0` sorts keys lexicographically, with no whitespace, and numbers and strings as `JSON.stringify` writes them. In Python that equals `json.dumps(obj, sort_keys=True, separators=(',',':'), ensure_ascii=False)` (reproduced byte-exact).
- **`deadline` collision:** for non-dry quotes the signed `deadline` is **`quote.deadline`** (deposit-address expiry). It overrides the request deadline. If the quote has none, the key disappears, because spreading `undefined` removes it. For dry quotes it is the request deadline.
- Canonical signed string of the live example above (sign target `DPmByLLDcHnmMEvZaAnUkeN3aas6kPLfQw9Li3j5L6Ha`):

```
{"amount":"5000000","amountIn":"5000000","amountInFormatted":"5.0","amountInUsd":"4.998500000000","amountOut":"931129435042566502055987","amountOutFormatted":"0.931129435042566502055987","amountOutUsd":"4.981542477478","deadline":"2026-10-21T18:20:18.000Z","depositType":"INTENTS","destinationAsset":"nep141:wrap.near","dry":true,"minAmountIn":"5000000","minAmountOut":"921818140692140837035427","originAsset":"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","quoteWaitingTimeMs":3000,"recipient":"sprout-demo.near","recipientType":"INTENTS","refundTo":"sprout-demo.near","refundType":"INTENTS","slippageTolerance":100,"swapType":"EXACT_INPUT","timestamp":"2026-10-21T18:10:18.355Z"}
```

- The docs say status payloads are signed too ("Both include `signature` and `timestamp`"). `GetExecutionStatusResponse.quoteResponse` carries the original signed quote.
- What the signature does **not** give you: proof that 1Click will settle, or that `depositAddress` isn't controlled by 1Click. It is. It proves origin and integrity only. 1Click remains a trusted operator, so bound the exposure with caps.

### Rust: on-chain verification in the vault (unit-tested with near-sdk 5.29.1 against the live quote)

Design: the agent passes the **exact canonical string** plus the signature. The vault hashes and verifies those bytes, then parses the same string. No canonicalization is needed on-chain, and every value the vault reads is covered by the signature.

```rust
// Cargo: near-sdk = "5.29.1", bs58 = { version = "0.5.1", default-features = false, features = ["alloc"] },
//        serde = { version = "1", features = ["derive"] }, serde_json = "1"
use near_sdk::{env, AccountId};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedQuote {
    pub dry: bool,
    pub swap_type: String,
    pub slippage_tolerance: u32,
    pub origin_asset: String,
    pub destination_asset: String,
    pub deposit_type: String,
    pub recipient: String,
    pub recipient_type: String,
    pub refund_to: String,
    pub refund_type: String,
    pub amount: String,
    pub amount_in: String,
    pub min_amount_out: String,
    pub deposit_address: Option<String>, // only when dry == false
    pub deadline: Option<String>,        // non-dry: deposit-address expiry
    pub timestamp: String,
}

/// message = base58(sha256(signed_json)) as ASCII bytes; ed25519 over it.
pub fn verify_1click_quote(signed_json: &str, signature: &str, pubkey: &str) -> bool {
    let sig_b58 = signature.strip_prefix("ed25519:").unwrap_or(signature);
    let pk_b58 = pubkey.strip_prefix("ed25519:").unwrap_or(pubkey);
    let Some(sig) = bs58::decode(sig_b58).into_vec().ok().and_then(|v| <[u8; 64]>::try_from(v).ok()) else { return false };
    let Some(pk) = bs58::decode(pk_b58).into_vec().ok().and_then(|v| <[u8; 32]>::try_from(v).ok()) else { return false };
    let message = bs58::encode(env::sha256_array(signed_json.as_bytes())).into_string();
    env::ed25519_verify(&sig, message.as_bytes(), &pk)
}

/// Policy checks for agent-routed swaps (add caps/allowlist/oracle/replay checks in the caller).
pub fn check_vault_quote(q: &SignedQuote, vault: &AccountId, now_ns: u64, max_age_ns: u64) -> Result<AccountId, &'static str> {
    if q.dry { return Err("dry quote"); }
    if q.swap_type != "EXACT_INPUT" { return Err("swapType"); }
    if q.deposit_type != "INTENTS" || q.recipient_type != "INTENTS" || q.refund_type != "INTENTS" { return Err("types"); }
    if q.recipient != vault.as_str() || q.refund_to != vault.as_str() { return Err("recipient/refundTo"); }
    if q.amount != q.amount_in { return Err("amount mismatch"); }
    let ts = parse_iso8601_utc_ns(&q.timestamp).ok_or("timestamp")?;
    if ts > now_ns || now_ns - ts > max_age_ns { return Err("stale quote"); }
    let dl = parse_iso8601_utc_ns(q.deadline.as_deref().ok_or("no deadline")?).ok_or("deadline")?;
    if dl <= now_ns + 120_000_000_000 { return Err("deadline too close"); }   // 2 min margin
    q.deposit_address.as_deref().ok_or("no depositAddress")?.parse::<AccountId>().map_err(|_| "depositAddress")
}

/// "YYYY-MM-DDTHH:MM:SS[.f{1,9}]Z" -> unix ns (1Click sends millisecond precision).
pub fn parse_iso8601_utc_ns(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || *b.last()? != b'Z' || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' { return None; }
    let num = |r: core::ops::Range<usize>| -> Option<i64> { core::str::from_utf8(&b[r]).ok()?.parse().ok() };
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 { return None; }
    let mut frac_ns = 0i64;
    if b.len() > 20 {
        if b[19] != b'.' { return None; }
        let f = &s[20..s.len() - 1];
        if f.is_empty() || f.len() > 9 || !f.bytes().all(|c| c.is_ascii_digit()) { return None; }
        frac_ns = f.parse::<i64>().ok()? * 10i64.pow(9 - f.len() as u32);
    }
    let y2 = if mo <= 2 { y - 1 } else { y };                 // days_from_civil (H. Hinnant)
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let secs = (era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + mi * 60 + se;
    u64::try_from(secs).ok()?.checked_mul(1_000_000_000)?.checked_add(frac_ns as u64)
}
```

Test vector, passing in a near-sdk unit test: `verify_1click_quote(<canonical string above>, "ed25519:nrEjMvMj…ucrar", "ed25519:reYaWhvw…Vifc") == true`. Replacing `sprout-demo.near` with `attacker.near` gives `false`. `parse_iso8601_utc_ns("2026-10-21T18:10:18.355Z") == 1_792_606_218_355_000_000`.

Vault checklist on top of the above:
- Keep a `LookupSet<[u8;32]>` of used `sha256(signed_json)` values (replay protection).
- `origin_asset` and `destination_asset` must be exactly `"nep141:<allowlisted token>"`.
- `u128` parse of `amount_in` against per-action and daily caps.
- `min_amount_out` against the oracle-derived floor (needs a price-fetch hop first).
- `slippage_tolerance` ≤ policy.
- Gas: `ed25519_verify` and sha256 on about 800 bytes are cheap (a few TGas) **[VERIFY with profiling]**.

### TypeScript: build the canonical string for the agent (mirror of SDK internals, which are not exported)

```ts
import stringify from 'json-stable-stringify';               // pin 1.3.0, same as the SDK
import { quoteHash, verifyQuoteSignature, type QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';
import { sha256 } from '@noble/hashes/sha2';
import { base58 } from '@scure/base';

export function signedQuoteString(r: QuoteResponse): string {
  const q = r.quoteRequest, o = r.quote as any, x = (v: any) => (v ? v : undefined);
  const req = { dry: q.dry, swapType: q.swapType, slippageTolerance: q.slippageTolerance, originAsset: q.originAsset,
    depositType: q.depositType, destinationAsset: q.destinationAsset, amount: q.amount, refundTo: q.refundTo,
    refundType: q.refundType, recipient: q.recipient, recipientType: q.recipientType, deadline: q.deadline,
    quoteWaitingTimeMs: x(q.quoteWaitingTimeMs), referral: x(q.referral), virtualChainRecipient: x(q.virtualChainRecipient),
    virtualChainRefundRecipient: x(q.virtualChainRefundRecipient), customRecipientMsg: x(q.customRecipientMsg) };
  const base = { amountIn: o.amountIn, amountInFormatted: o.amountInFormatted, amountInUsd: o.amountInUsd,
    minAmountIn: o.minAmountIn, amountOut: o.amountOut, amountOutFormatted: o.amountOutFormatted,
    amountOutUsd: o.amountOutUsd, minAmountOut: o.minAmountOut };
  const quote = q.dry ? base : { ...base, depositAddress: x(o.depositAddress), depositMemo: x(o.depositMemo),
    deadline: x(o.deadline), timeWhenInactive: x(o.timeWhenInactive), timeEstimate: x(o.timeEstimate),
    refundFee: x(o.refundFee), withdrawFee: x(o.withdrawFee) };
  const s = stringify({ ...req, ...quote, timestamp: r.timestamp })!;
  // self-check against the SDK so drift is caught off-chain, not on-chain
  if (base58.encode(sha256(new TextEncoder().encode(s))) !== quoteHash(r)) throw new Error('canonicalization drift');
  if (!verifyQuoteSignature(r)) throw new Error('bad 1Click signature');
  return s;
}
```

## 7. Funding a quote whose `depositType` is `INTENTS` (RESOLVED)

The docs describe two paths for `INTENTS` deposits:
1. **Signed intent** (docs: "Generate intent, user signs, `POST /v0/submit-intent`"). `generate-intent` returns a NEP-413 payload whose message is a **`token_diff`** for `signerId`, e.g. `{"intent":"token_diff","diff":{"nep141:wrap.near":"-1000…","nep141:usdt.tether-token.near":"1000000"}}`. This needs a key registered on `intents.near` for the signer, so it is **not usable by a key-less vault**, and registering a key is forbidden (SKILL.md rule 1).
2. **Transfer inside Intents to `depositAddress`.** The OpenAPI defines `depositType: INTENTS` as "the account ID within NEAR Intents to which you should transfer assets", and `Quote.depositAddress` as "The deposit address inside NEAR Intents (the verifier smart contract) when depositType is INTENTS". For a contract this is `intents.near mt_transfer({receiver_id: depositAddress, token_id: "nep141:<in>", amount: amountIn})`, 1 yocto, with predecessor auth.

Production evidence for path 2 from a contract account: NEAR DevHub's **Trezu** treasury (Sputnik DAO contracts, which can't sign) quotes with `depositType: "INTENTS"` / `refundType: "INTENTS"` / `refundTo: <dao>` and funds through a DAO proposal:

```ts
// github.com/NEAR-DevHub/trezu  nt-fe/lib/near-proposal-builders.ts  (release-1.31.1, 2026-10-21)
FunctionCall: { receiver_id: "intents.near", actions: [{ method_name: "mt_transfer",
  args: { receiver_id: depositAddress, amount: amountIn, token_id: tokenAddress /* "nep141:…" */ },
  deposit: "1", gas: FT_TRANSFER_GAS }] }
// and for NEAR-chain FTs it uses ORIGIN_CHAIN + token.ft_transfer({receiver_id: depositAddress, amount}) with 1 yocto
```

**Verdict for the vault:** use `mt_transfer(depositAddress, "nep141:<in>", amountIn)`. If the vault holds the token outside Intents, first `ft_transfer_call(intents.near, msg="")` to credit itself, then `mt_transfer`.
- `ft_transfer_call(intents.near, amount, msg = depositAddress)` would also credit `depositAddress` (DepositMessage account form) in one step. We found **no doc or production code** saying 1Click detects that deposit (it shows up as a mint/deposit event, not an `mt_transfer`). **[VERIFY with a small mainnet test]** before relying on it.
- An `ORIGIN_CHAIN` quote whose origin is a NEAR NEP-141 can be funded with a plain `token.ft_transfer(depositAddress)` (Trezu does this). Refunds then go to `refundTo` on NEAR (outside Intents), which is less convenient for the vault's accounting.
- The format of an `INTENTS` `depositAddress` wasn't observable with dry quotes. A Trezu review comment mentions a hex address, so expect a 64-hex implicit account id **[VERIFY]**. Parse it with `AccountId` in any case.
- After funding: output arrives in the vault's Intents balance (`recipientType: INTENTS`). Refunds (deadline, partial) arrive there too as `originAsset`. Settle from `mt_batch_balance_of(vault, [in, out])`, then call `ft_withdraw` without `msg`.

## 8. TypeScript examples (SDK 0.1.26, near-api-js 7.x)

```ts
import { OpenAPI, OneClickService, QuoteRequest, ApiError } from '@defuse-protocol/one-click-sdk-typescript';
OpenAPI.BASE = 'https://1click.chaindefuser.com';
OpenAPI.HEADERS = { 'X-API-Key': process.env.ONECLICK_JWT! };        // or OpenAPI.TOKEN = jwt (Bearer)

// (a) Inbound funding: user pays BTC/ETH/SOL/USDC on another chain, vault receives inside Intents.
const fund = await OneClickService.getQuote({
  dry: false,
  swapType: QuoteRequest.swapType.EXACT_INPUT,
  slippageTolerance: 100,
  originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',   // USDC on Base
  depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
  destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // USDC on NEAR
  amount: '20000000',
  refundTo: userBaseAddress, refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
  recipient: vaultId,        recipientType: QuoteRequest.recipientType.INTENTS,
  deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
});
// show fund.quote.depositAddress (+ depositMemo) to the user; poll:
const st = await OneClickService.getExecutionStatus(fund.quote.depositAddress!);   // PENDING_DEPOSIT … SUCCESS

// (b) Agent route: request an INTENTS/INTENTS/INTENTS quote naming the vault, then hand the signed string to the vault.
const r = await OneClickService.getQuote({ dry: false, swapType: QuoteRequest.swapType.EXACT_INPUT, slippageTolerance: 50,
  originAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  depositType: QuoteRequest.depositType.INTENTS, destinationAsset: 'nep141:wrap.near', amount: '5000000',
  refundTo: vaultId, refundType: QuoteRequest.refundType.INTENTS,
  recipient: vaultId, recipientType: QuoteRequest.recipientType.INTENTS,
  deadline: new Date(Date.now() + 10 * 60_000).toISOString() });
const signedJson = signedQuoteString(r);                                    // §6 helper
await agentAccount.callFunction({ contractId: vaultId, methodName: 'agent_route_intents',
  args: { quote_json: signedJson, signature: r.signature, reason_hash }, gas: 300_000_000_000_000n, deposit: 0n });
```

Errors: `ApiError` has `.status` and `.body` (400 → `{message}`). Treat 400 "Internal server error" on NEAR `DESTINATION_CHAIN` as a likely missing account or storage registration.

# Rhea concentrated liquidity (DCL / "Rhea V2" / CLMM): `dclv2.ref-labs.near`

Checked 2026-10-22. Live `get_metadata`:
- `version` **"2.3.15"**, `state` "Running", owner `ref-finance.sputnik-dao.near`, `wnear_id` `wrap.near`, `protocol_fee_rate` 2000, `pool_count` 5786.
- Code hash `8FYiayAinMQr5aTLmYuPYNReqeLeLmrz3ceUXgdsuHgE`.
- Testnet: `dclv2.ref-dev.testnet`.

**About the sources.** The official source `github.com/ref-finance/ref-dcl` (linked from the official guide) returns **404**. No public source exists. What's below is reconstructed from:
1. The live wasm export list and its embedded serde/error strings.
2. Real mainnet transactions (receipts + logs).
3. The official TS SDK (`@ref-finance/ref-sdk` 1.5.0 / `rhea-finance/rhea-sdk` `src/dcl-swap/*`).
4. Burrow's `contracts/mock-dcl` in `ref-finance/burrowland` (a *mock*, used only as a hint, labelled where used).

## Resolved: "dclv2 direct swap interface"

**There is no `swap` method on DCL.** The exported methods include `quote`, `quote_by_output`, `ft_on_transfer`, `withdraw_asset`, `get_pool`, `list_pools`, `list_user_assets`, `get_user_asset`, `storage_deposit` and others, but no `swap` / `execute_actions`. **Swaps happen only through `token_in.ft_transfer_call(receiver_id = "dclv2.ref-labs.near", amount, msg)`.**

### Pool id format
`"{token_x}|{token_y}|{fee}"`:
- Token ids are **sorted lexicographically** (`[a,b].sort().join('|')`, SDK `getDCLPoolId`).
- `fee` is in hundredths of a bp ÷ 1e6 → `100` = 0.01%, `400` = 0.04%, `2000` = 0.2%, `10000` = 1%. The valid list is `DCL_POOL_FEE_LIST = [100, 400, 2000, 10000]`.
- e.g. `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|100` (USDC sorts before `wrap.near`), `usdt.tether-token.near|wrap.near|100`.

### `ft_transfer_call` msg (externally tagged enum `TokenReceiverMessage`)
Variants in the live wasm: `Deposit`, `Swap`, `SwapByOutput`, `SwapByStopPoint`, `LimitOrder`, `LimitOrderWithSwap`, `HotZap`.

**Swap**: exact msg from a real mainnet tx (`DoShjzuqXUgawgCH9q1rDPMMJte8uXRuuJJtptKULaCt`, 2026-10-22, 1 yocto, 100.7 Tgas):
```json
{"Swap":{"pool_ids":["ai-8.nearlytrade.near|wrap.near|10000"],
         "output_token":"ai-8.nearlytrade.near",
         "min_output_amount":"79370712743747781938",
         "skip_unwrap_near":true,
         "referral_id":"dex-aggregator.intear.near"}}
```
- Live wasm says `TokenReceiverMessage::Swap with 8 elements`. Field names present in the wasm: `pool_ids`, `output_token`, `min_output_amount`, `skip_unwrap_near`, `referral_id`, `client_echo`, `swap_out_recipient`, `extra_tgas_for_client_echo`. Also the assert *"client_echo and swap_out_recipient cannot have value at the same time"*.
- The exact 8-field set is **[VERIFY]**, but the 5 fields in the tx above are proven.
- The SDK also sends `"client_id": ""`. It's harmless (serde ignores it) but not needed for `Swap`.
- `pool_ids` is a **path**: multi-hop is allowed, and `min_output_amount` is checked **only on the final output**. A vault should pass exactly one allowlisted pool.
- `referral_id` only counts if whitelisted (`get_referral_whitelist` / `is_valid_referral`).
- **Always set `"skip_unwrap_near": true`.** In Burrow's mock-DCL the default is `unwrap_or_default()` = false, which **unwraps wNEAR output to native NEAR** (`mock-dcl/src/user_asset.rs:81-88`). That's the opposite of Ref v2's default. Live default unconfirmed **[VERIFY]**. Set it explicitly either way.

**SwapByOutput**: `{"SwapByOutput":{"pool_ids":[…],"output_token":"…","output_amount":"…"}}`. The unused input is refunded through `ft_on_transfer`'s return value. Source: SDK `dcl-swap/swap.ts`. The mock says "under construction", but the live wasm has an 8-element variant.

**Deposit**: `"Deposit"`. Credits DCL internal user assets (for limit orders/liquidity). It's not used for swaps.

### What a swap does on-chain (traced from tx `DoShjzu…`)
1. `wrap.near.ft_transfer_call` → `dclv2.ref-labs.near.ft_on_transfer(sender, amount, msg)`. The swap math runs and **returns `"0"`** (all input used). It logs:
   ```
   EVENT_JSON:{"standard":"dcl.ref","version":"1.0.0","event":"swap","data":[{"swapper":"…","token_in":"wrap.near","token_out":"…","amount_in":"…","amount_out":"80172437114896749433","pool_id":"…","total_fee":"…","protocol_fee":"…","referral_id":"…","referral_fee":"0"}]}
   ```
2. **Detached** `token_out.ft_transfer(receiver_id = sender, amount = amount_out)`, then `dclv2.callback_post_withdraw_asset(token_id, user_id, amount)` → `true`.
3. In parallel, `wrap.near.ft_resolve_transfer` → sender sees **used = amount_in**.

Failure semantics:
- **Slippage fails** (`E204: slippage error`), or any other panic in `ft_on_transfer` (`E404: invalid pool ids`, `E212: invalid output token`, `E213: invalid input token`, paused pool/contract): the token refunds the **full input** to the sender (standard NEP-141). The sender's callback sees **used = 0**.
- **Output transfer fails** (e.g. the receiver isn't storage-registered on `token_out`): `callback_post_withdraw_asset` re-credits the amount. In mock-DCL it goes to the user's **DCL internal asset** if the user is registered with DCL, else to a locked "lostfound" (event `Lostfound{locked:true}`). Recover with `withdraw_asset`. **[VERIFY live behaviour]**
- `withdraw_asset`:
  - Live wasm: *"Method withdraw_asset doesn't accept deposit"*, i.e. **non-payable, attach 0**, unlike Ref v2's `withdraw`.
  - Mock signature: `withdraw_asset(token_id: AccountId, amount: Option<U128>, skip_unwrap_near: Option<bool>) -> PromiseOrValue<bool>`. `amount` None = all. **[VERIFY args on live]**
  - Balances: `list_user_assets({account_id})`, `get_user_asset(...)`.

**No DCL storage registration is needed to swap.** The swapper in tx `DoShjzu…` has `storage_balance_of` = `null` on DCL. DCL `storage_balance_bounds.min` = 0.5 NEAR; that's only needed for orders/liquidity/internal assets. The swapper must be registered on `token_out` (the SDK adds `storage_deposit` on tokenB when needed).

### Can a contract swap on DCL and know the output amount on-chain?
**Not deterministically from the call chain.**
- `ft_on_transfer` returns `0` and sends the output with a **detached** `ft_transfer`. `amount_out` exists only in the `EVENT_JSON` log, which contracts cannot read.
- The vault's `ft_transfer_call` callback learns only `used == amount_in` (success) or `0` (refunded).
- What *is* guaranteed: on success, DCL enforced `amount_out ≥ min_output_amount` atomically. The vault sets that from its oracle. The exceptions are fee-on-transfer tokens (tx above: the token skimmed a 1% "tax" on the way out) and the output-transfer-failed path.
- `client_echo` (DCL sends output with `ft_transfer_call` back to the sender, so the vault's own `ft_on_transfer` would see the exact amount) is **gated by `client_echo_sender_whitelist` / `secure_sender_whitelist`**, which only Rhea's owner controls. It's not available to us.

If the vault must use DCL, use this pattern:
```
snapshot = token_out.ft_balance_of(vault)                (take the lock first)
token_in.ft_transfer_call(dclv2, amount_in, msg = Swap{pool_ids:[one allowlisted id], output_token, min_output_amount: oracle_min_out, skip_unwrap_near: true})
  .then(on_dcl_swapped(used)):  used == 0 → failed, nothing moved; used == amount_in → swap happened
  .then(token_out.ft_balance_of(vault)).then(on_dcl_measured(snapshot)) → delta = actual_out (≥ min_out expected)
```
Caveats:
- The output `ft_transfer` receipt is created **before** the vault's balance-check receipt and goes to the same token shard, so in practice it executes first. That's **not a documented protocol guarantee [VERIFY in sandbox]**.
- Treat `delta < min_out` as "pending". Re-check in `sync_position` and check `list_user_assets(vault)` for a re-credited output.
- Anyone can send tokens to the vault, which inflates `delta`. That only makes the measurement look better, never worse, so settle caps on the conservative side (use `min_out` for accounting until reconciled).

**Recommendation for Trellis:**
- **Keep the vault on Ref v2 classic pools (`classic-pools.md`).** Ref v2 pool 4512 is the deepest wNEAR/USDC venue anyway (see the liquidity table below). The deposit→swap→withdraw model gives an exact on-chain `amount_out`.
- Use DCL only from the frontend / user wallet, or via the smart router.

## Quote views

```json
quote          {"pool_ids":["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|100"],
                "input_token":"wrap.near","output_token":"17208628…","input_amount":"1000000000000000000000000000","tag":"t"}
               → {"amount":"5328082671","tag":"t"}
quote_by_output {"pool_ids":[…],"input_token":"…","output_token":"…","output_amount":"…"}  → {"amount": input_needed, "tag": …}
get_pool       {"pool_id":"<id>"} → see below; returns null for a non-existent pool
list_pools     {"from_index"?, "limit"?}  (SDK calls it with no args)
```
- `tag` is optional and echoed back.
- **`quote` returns `"0"` (not an error) when the pool can't fill the amount.** Live example: 10,000 wNEAR on `…|wrap.near|2000` → `{"amount":"0"}`. Treat 0 as "no route".

`get_pool` shape (live, USDC/wNEAR fee 100):
```json
{"pool_id":"17208628…|wrap.near|100","token_x":"17208628…","token_y":"wrap.near","fee":100,"point_delta":1,
 "current_point":397716,"liquidity":"32249075720347750","liquidity_x":"32249075720347750","max_liquidity_per_point":"…",
 "total_fee_x_charged":"…","total_fee_y_charged":"…","volume_x_in":"…","volume_y_in":"…","volume_x_out":"…","volume_y_out":"…",
 "total_liquidity":"33183419955462684","total_order_x":"37931165134","total_order_y":"4265839296925782936595776892",
 "total_x":"344172103334","total_y":"60366745902343109225687530438","state":"Running","whitelist":null}
```
Check `state == "Running"`. `total_x/total_y` include limit-order inventory.

## Liquidity snapshot (live, 2026-10-22, NEAR ≈ $5.37)

| Pool | total_x | total_y | ≈ TVL | `liquidity` (active) |
|---|---|---|---|---|
| USDC/wNEAR fee **100** | 344,172 USDC | 60,367 wNEAR | ~$0.67M | 3.2e16 |
| USDC/wNEAR fee 400 | 7.7 USDC | 10.0 wNEAR | ~$0 | 0 |
| USDC/wNEAR fee 2000 | 9,864 USDC | 83,747 wNEAR | ~$0.46M (mostly out of range) | 6.4e14 |
| USDC/wNEAR fee 10000 | ~0 | ~0 | — | 0 |
| USDT/wNEAR fee 100 | 6,271 USDT | 184.9 wNEAR | ~$7k | 1.2e12 |
| USDT/wNEAR fee 2000 | 1,277 USDT | 399.9 wNEAR | ~$3k | 2.7e13 |
| USDC/USDT fee 100 / 400 | ~400 each | | <$1k | tiny |

Quote comparison, wNEAR → USDC (6 decimals):

| in | DCL fee 100 | DCL fee 2000 | Ref v2 pool 4512 (SIMPLE) | Ref v2 pool 5515 (DEGEN) |
|---|---|---|---|---|
| 100 wNEAR | 534.53 | 526.14 | 534.49 | 533.75 |
| 1,000 | 5,328.1 | 4,985.6 | 5,323.2 | 5,335.1 |
| 10,000 | 51,636 | 0 (can't fill) | 51,160 | 53,112 |

DCL wNEAR/USDT is **thin**: 100 wNEAR → 412 USDT vs 534 on Ref pool 6063. For USDT, use Ref v2 6063 or route through USDC.

## Rust: the msg for a DCL swap from a contract
```rust
#[near(serializers = [json])]
pub enum DclMsg {               // externally tagged ⇒ {"Swap":{…}}
    Swap {
        pool_ids: Vec<String>,
        output_token: AccountId,
        min_output_amount: U128,
        skip_unwrap_near: Option<bool>,
    },
}
let msg = near_sdk::serde_json::to_string(&DclMsg::Swap {
    pool_ids: vec![format!("{}|{}|{}", a_sorted, b_sorted, fee)],
    output_token: token_out.clone(),
    min_output_amount: U128(min_out),
    skip_unwrap_near: Some(true),
}).unwrap();
ext_ft::ext(token_in).with_attached_deposit(NearToken::from_yoctonear(1)).with_static_gas(Gas::from_tgas(100))
    .ft_transfer_call("dclv2.ref-labs.near".parse().unwrap(), U128(amount_in), None, msg)
```
- Gas: the SDK attaches **180 Tgas**. The traced tx attached 100.7 Tgas: `ft_on_transfer` burned 8.0 T, the token transfer 2.0 T, the callback 2.4 T.
- Build `pool_ids` with sorted token ids, and check them against the vault's allowlist **as strings**. Then call `get_pool` and verify `token_x`/`token_y` == {token_in, token_out} and `state == "Running"`.

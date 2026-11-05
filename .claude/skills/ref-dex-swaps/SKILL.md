---
name: ref-dex-swaps
description: >
  How to swap on Rhea (formerly Ref Finance) DEX on NEAR, from a Rust contract and from TypeScript.
  Covers classic pools on v2.ref-finance.near (storage/register_tokens, instant swap msg,
  deposit → swap → withdraw with on-chain amount_out), the concentrated-liquidity DEX
  dclv2.ref-labs.near (ft_transfer_call Swap msg, "tokenA|tokenB|fee" pool ids, quote),
  the smart router / aggregatedex.near (frontend only), price APIs, and live pool ids for
  wNEAR/USDC and wNEAR/USDT. Use when writing or reviewing any code that swaps on Ref/Rhea
  DEX, computes or passes min_amount_out, picks or allowlists pools, or calls
  v2.ref-finance.near, dclv2, smart router, smartx, aggregatedex. Not for Burrow lending
  (see rhea-burrow-lending).
---

# Ref / Rhea DEX swaps

Snapshot date: **2026-10-22**. Live values: Ref v2 `version` 1.9.20, DCL `version` 2.3.15, both `state: Running`.

## Contract IDs (mainnet)
| Role | Account |
|---|---|
| Classic AMM (simple / stable / rated / degen pools) | `v2.ref-finance.near` (testnet `ref-finance-101.testnet`) |
| Concentrated liquidity "Rhea V2 / DCL / CLMM" | `dclv2.ref-labs.near` (testnet `dclv2.ref-dev.testnet`) |
| Aggregated DEX (server-signed routes) | `aggregatedex.near` |
| wNEAR | `wrap.near` |
| USDC (native) | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| USDT (native) | `usdt.tether-token.near` |
| Owner / upgrades | `ref-finance.sputnik-dao.near` (DAO upgrades directly, no timelock) |
| Oracle the vault should use | `aggregate-oracle.near` (not a DEX quote) |

Pools to allowlist (live liquidity check, details in `classic-pools.md` §6):
- **wNEAR/USDC: Ref v2 pool `4512`** (SIMPLE_POOL, 0.30%, ~$2.4M, the deepest on Rhea).
- wNEAR/USDT: pool `6063` (DEGEN_SWAP, 0.30%, ~$0.45M). It's oracle-assisted, so sandbox-test it first.
- The DCL wNEAR/USDC fee-100 pool (~$0.67M) is competitive only on small trades. DCL USDT pools are thin.

## Decisions already made (with why)
1. **The vault swaps only on Ref v2, using the deposit model**: `ft_transfer_call(msg "")` → `swap(actions)` returns `U128 amount_out` → `withdraw(token_out, amount_out)`. This is the only Rhea path where a contract learns the exact output on-chain.
   - Instant swaps (`ft_transfer_call` with an `actions` msg) and DCL swaps send the output with a detached `ft_transfer`. The caller sees only "used = amount_in".
2. **DCL has no `swap` method.** Swaps go only through `ft_transfer_call` with `{"Swap":{pool_ids, output_token, min_output_amount, skip_unwrap_near}}`. DCL enforces `min_output_amount` atomically, but the amount out is only visible in logs or through a balance diff. See `dcl-pools.md`.
3. **The smart router / `aggregatedex.near` is frontend-only.** Its `msg` is an opaque, obfuscated, server-signed blob.
4. **`swap` does not require 1 yocto** (it's `#[payable]` with no assert). With 0 deposit, every token must be registered in the caller's Ref account (or globally whitelisted), else `E27`. **`withdraw` and `register_tokens` require exactly 1 yocto.**

## April 2026 Rhea exploit: lessons that shape this code
On 16 Apr 2026 Rhea lost ~$18.4M (post-mortem figure; early reports said ~$7.6M). Attack path:
- The attacker deployed ~123 fake tokens and created pools for them on Ref, building fake swap routes.
- They then opened Burrow **margin** positions whose swap paths ran through those pools.
- The margin validation **summed `min_amount_out` across hops** (also miscounting reused intermediate tokens), so per-hop minimums like 999,999 + 11 passed the check.
- It never verified what the swap actually delivered. Borrowed tokens flowed into the attacker's pools.
- Margin trading is still off (`get_enabled_margin_actions` = `["Withdraw"]`), and the DEX was paused for a while.

Sources: The Block, QuillAudits, rekt.news (see Sources). Exact mechanics differ between write-ups **[VERIFY against Rhea's official post-mortem]**.

What this means for us:
- **Allowlist pool ids AND tokens.**
  - Before moving funds, `get_pool(pool_id)` and require `token_account_ids` to be exactly {token_in, token_out} with an allowed `pool_kind`.
  - Identify tokens by account id, never by symbol.
  - Anyone can create a Ref pool (8,979 exist, most junk), and anyone can deploy a token called "USDC".
- **Single hop only.** Ref checks `min_amount_out` on *every* hop. DCL checks only the final output. Never add up per-hop minimums. One hop with one oracle-derived min removes the problem.
- **`min_out` comes from the oracle, computed by the vault.** Never from the agent, a pool quote, or the router.
- **Verify what you received.** Use the `swap` return value, then `withdraw`'s resolved `U128`, then reconcile with `get_deposits` / `ft_balance_of`.
- Check `metadata.state == "Running"` and `get_frozenlist_tokens`. Guardians can freeze tokens and the DAO can pause the contract.

## Most common mistakes
1. Forgetting `min_amount_out` in a `SwapAction`. Because `Action` is `#[serde(untagged)]`, the JSON then gets parsed as `SwapByOutput`. Always send all five fields: `pool_id, token_in, amount_in, token_out, min_amount_out`.
2. Using `registration_only: true` for the vault's Ref `storage_deposit`. It leaves no room for token entries, so a later `swap` fails with `E11`.
   - Base storage is 0.00102 NEAR, plus 0.00148 NEAR per token. Attach 0.01 NEAR, then `register_tokens` (1 yocto).
3. Vault not registered on the output token contract. Ref `withdraw` then resolves to `U128(0)` and the funds sit in the Ref deposit (they aren't lost). DCL output goes to its internal asset or lostfound.
4. Passing `amount: "0"` to `withdraw`. That means **withdraw everything** of that token.
5. wNEAR unwrapping:
   - Ref v2 *does not* unwrap unless `skip_unwrap_near: false`.
   - DCL's (mock) default *does* unwrap.
   - Always pass `skip_unwrap_near: true` explicitly.
6. DCL pool id with unsorted tokens, or a fee not in {100, 400, 2000, 10000}. `quote` returns `{"amount":"0"}` (not an error) when the pool can't fill.
7. Treating an instant-swap / DCL `ft_transfer_call` result as the output amount. It is the *input used*.
8. Callbacks that panic. Use `#[callback_result]` and handle all three `withdraw` outcomes: `Ok(amount)`, `Ok(0)`, `Err`.
9. Using `@ref-finance/ref-sdk` 1.5.0 in a near-api-js v7 app. It pins `near-api-js` 0.44.2. Copy its msg shapes instead.
10. Trusting `indexer.ref.finance` prices or the token list for anything on-chain.

## Reference index
- `classic-pools.md`: v2.ref-finance.near
  - storage / `register_tokens`
  - exact `SwapAction` / `Action` / `PoolInfo` types
  - instant-swap msg (all fields, `skip_unwrap_near`, `swap_out_recipient`, `referral_id`, `client_echo`)
  - deposit → `swap` → `withdraw` semantics and refunds
  - views (`get_pool(s)`, `get_return`, `predict_swap_actions`, `get_deposits`, …)
  - live pool table for wNEAR/USDC and wNEAR/USDT
  - **Rust vault callback chain**, gas numbers, error strings
- `dcl-pools.md`: dclv2.ref-labs.near
  - no `swap` method; exact `{"Swap":{…}}` msg from a mainnet tx
  - pool id format, `quote` / `get_pool` shapes, liquidity snapshot
  - output determinism analysis and the balance-diff pattern
  - Rust msg builder
- `routing-and-apis.md`
  - `smartx.rhea.finance/swapMultiDexPath` + `aggregatedex.near` flow
  - legacy `smartrouter.ref.finance/findPath`
  - price/token APIs, npm versions
  - **TypeScript (near-api-js 7.3.1 + near-connect 0.11.4)** quote and wallet-swap builders

Related skills: `trellis-vault` (policy and the vault spec), `rhea-burrow-lending` (Burrow). The vault spec flow is `docs/vault-spec.md` §6.3, and open question #3 there is answered above.

## Open [VERIFY] items (carry these into sandbox tests)
- Sandbox gas profile for the full deposit→swap→withdraw chain (estimate ≈150–220 Tgas, which fits in 300).
- Degen pool (6063 / 5515) behaviour when the oracle price is stale, and the gas cost of degen price sync.
- DCL: the exact 8-field `Swap` struct, the live `skip_unwrap_near` default, `withdraw_asset` args, and where a failed output transfer lands.
- DCL balance-diff ordering (output `ft_transfer` vs. the vault's `ft_balance_of`). It works in practice but isn't a protocol guarantee.
- 1.9.18 → 1.9.20 argument changes (the method names were confirmed on the live wasm).
- Official April 2026 post-mortem details.

## Sources (accessed 2026-10-22)
- Live mainnet RPC `https://rpc.mainnet.fastnear.com`: `metadata`, `version`, `get_pool(s)` (all 8,979 paged), `get_return`, `predict_swap_actions`, `storage_balance_bounds`, `get_whitelisted_tokens`, `get_frozenlist_tokens`; DCL `get_metadata`, `get_pool`, `quote`, `storage_balance_of`; `view_code` export lists (Ref hash `25eNFdfK76NUEZn4cDgq1xQYKjxKCuzgXmPB3SHBRW4Y`, DCL hash `8FYiayAinMQr5aTLmYuPYNReqeLeLmrz3ceUXgdsuHgE`).
- Mainnet txs: DCL swap `DoShjzuqXUgawgCH9q1rDPMMJte8uXRuuJJtptKULaCt`; Ref `swap` `8HTZwvgSrAt2KG62Q6BrQsRkPBCjZZXYheL3SDSpqBX2` (1 yocto) and `389uyDhdps6C5SkP76WMmakDN3ya6TEppZvY2xeg6da6` (0 deposit, E68); `withdraw` `3gNueTM7eZqJob2Cf5RJhoZzZpWqCTEHgA88VEMhVSbz` (via NearBlocks API).
- Contract source: the official `github.com/ref-finance/ref-contracts` and `ref-dcl` return 404. Used the **unofficial copy** `github.com/DevOfCredit/ref-contracts` (v1.9.18, commit b444323) `ref-exchange/src/{lib,action,token_receiver,account_deposit,storage_impl,views,utils,errors}.rs`; and `github.com/ref-finance/burrowland` `contracts/mock-dcl` (a mock).
- Official guide `github.com/ref-finance/guide`: `developers/contracts.md` (contract list, Frozen List), `developers-1/cli-trading.md`, `developers-1/rhea-dex-referral-setup.md`.
- Official SDK docs `github.com/rhea-finance/rhea-sdk-docs` `SmartRouterV2(Aggregated DEX).md`, `CrossChainDexAPI.md`; SDK source `github.com/rhea-finance/rhea-sdk` / `ref-finance/ref-sdk` `src/dcl-swap/*`, `src/constant.ts`, `src/indexer.ts`.
- npm registry: near-api-js 7.3.1, @hot-labs/near-connect 0.11.4, @ref-finance/ref-sdk 1.5.0; crates.io near-sdk 5.29.1.
- Exploit: https://www.theblock.co/post/397961/rhea-finance-post-mortem-exploit-losses-18-4-million-double-initial-estimates · https://www.quillaudits.com/blog/hack-analysis/rhea-finance-hack · https://alpha.rekt.news/rhea-finance-rekt · https://halborn.com/blog/post/explained-the-rhea-finance-hack-april-2026

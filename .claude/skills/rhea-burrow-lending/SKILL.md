---
name: rhea-burrow-lending
description: How to integrate with Rhea Finance lending (Burrow, contract.main.burrow.near) on NEAR from a Rust contract and from TypeScript - storage registration, supply via ft_transfer_call, the Action enum (IncreaseCollateral, DecreaseCollateral, Borrow, Repay, Withdraw), execute vs execute_with_pyth, reading positions, computing the health factor from aggregate-oracle prices, liquidation rules, and leverage loop / unwind sequences. Use when code or a plan touches Rhea, Burrow, lending, borrow, repay, collateral, health factor, liquidation, execute_with_pyth, get_account_all_positions, or aggregate-oracle. Not for Ref DEX swaps (see ref-dex-swaps).
---

# Rhea (Burrow) lending on NEAR

Verified on 2026-10-22 against the contract source, live mainnet RPC and guide.rhea.finance. Read the reference files before you write any message JSON or HF math. Copy shapes from them, don't write them from memory.

## What it is now

- **Rhea Finance** is the 2025 merger/rebrand of Ref Finance (DEX) and Burrow (lending). The lending contract is still the Burrow contract, **`contract.main.burrow.near`**. It is a pooled money market with share-based supply and borrow pools, one "REGULAR" position per account (plus LP-token "shadow" positions you should ignore), and an account-level health factor.
- **Prices:** Pyth-style oracle **`aggregate-oracle.near`** (Rhea's own aggregator, v0.4.1, source repo not public). Burrow config: `enable_pyth_oracle: true`, `enable_price_oracle: false` (the old `priceoracle.near` / `oracle_call` flow is off), `pyth_price_valid_duration_sec: 60`. Feeds update about every 30 s.
- **Deployed version is 0.16.2. The public repo is 0.15.7** (ref-finance/burrowland HEAD `2110c70`, 2025-12-02, no newer commits). The 0.16.x source is not published. Every user-facing method/enum variant this skill uses exists in the deployed wasm (export list + embedded variant strings checked). New in 0.16.x, seen only in the wasm and live views: `contract_mode` (`Running` | `RunningWithoutPublicLiquidation` | `Maintenance`, currently `Running`), `pause_contract`, a maintenance-mode whitelist ("Account is not allowed in maintenance mode"), a delist-token list ("Borrow is not allowed because REGULAR_POSITION has delist token as collateral"), `get_storage_balance_of_detail`, liquidation-benefit rates.
- **April 16 2026 exploit (~$18.4M):** it hit the **margin-trading** module only. The margin swap slippage check summed `min_amount_out` across multi-hop routes through attacker-made fake tokens/pools, which left positions undercollateralized, and the liquidations then drained reserves. Most of the funds were returned or frozen (secondary reports, see Sources). On-chain now: `get_enabled_margin_actions` → `["Withdraw"]` (margin can only be closed or withdrawn). **Regular supply/borrow/repay/withdraw works.** Don't touch `margin_execute*`, `DepositToMargin`, `MarginExecute*`, or `SwapReference`.
- **Testnet:** `contract.1689937928.burrow.testnet` runs **v0.11.0** (no `OnlyRepay`/`OnlyIncreaseCollateral`/`simple_withdraw`). Its `pyth-oracle.testnet` feeds are stale (months old) and `wrap.testnet` uses a fixed `default_price`. Not useful for integration tests. **Test in near-workspaces sandbox** with the mainnet wasm + `contracts/mock-pyth` (note: mock ignores `age`), then smoke-test on mainnet with small amounts.

## Contract IDs (mainnet)

| What | Account |
|---|---|
| Lending | `contract.main.burrow.near` (owner `burrow.sputnik-dao.near`) |
| Oracle used by Burrow | `aggregate-oracle.near` (`get_price_no_older_than`) |
| wNEAR | `wrap.near`: 24 decimals, `extra_decimals` 0, volatility_ratio 7500, price id `c415de8d…e226750` |
| Native USDC | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`: 6 decimals, `extra_decimals` 12, volatility_ratio 9500, price id `eaa020c6…a9e9c94a` |
| USDT | `usdt.tether-token.near`: 6 + 12, price id `2b89b9dc…88e2e53b` |

Full price ids and the other assets are in `references/views-and-health.md`.

## Most common mistakes (each one checked in source)

1. **Supplying without collateralizing.** `msg: ""` only *supplies*. Supplied balance earns interest but **does not count toward HF**. To collateralize, use `msg = "\"OnlyIncreaseCollateral\""` (a JSON *string*, quotes included) or `{"Execute":{"actions":[{"IncreaseCollateral":{"token_id":"…","max_amount":"<inner>"}}]}}`.
2. **Unquoted unit variants.** `msg: "OnlyRepay"` fails to parse, Burrow panics and the transfer is refunded. Correct: `"\"OnlyRepay\""` (or `{"OnlyRepay":null}`).
3. **Inner decimals.** Every `amount`/`max_amount` in Actions, and every balance in views, uses `token_decimals + extra_decimals`. USDC: 1 USDC = `1e18` inside Burrow, but `1e6` in `ft_transfer_call.amount`. Burrow scales the ft amount up itself (`fungible_token.rs:47`).
4. **Borrow via `execute`.** Borrow and DecreaseCollateral-with-debt need prices. `execute` passes empty prices, so the risk check panics "Asset … price is missing". Use **`execute_with_pyth`**.
5. **Awaiting the borrow.** `execute_with_pyth` returns `()`. The oracle promise and callback are detached, so your `.then` only sees the first receipt. **Reconcile** by reading `get_account_all_positions` + `ft_balance_of` in a later transaction.
6. **`ExecuteWithPyth` inside `ft_transfer_call`.** The deposit is committed and `ft_on_transfer` returns 0 *before* prices arrive. If the actions then fail, the tokens stay in Burrow as plain *supplied*. No refund, and your `ft_resolve_transfer` callback reports full use. Prefer plain `Execute`/`OnlyIncreaseCollateral` (synchronous, refunds on panic).
7. **Leaving dust or surplus as supplied.** `Borrow` credits *supplied*, then `Withdraw` sends it out, about 1 inner unit less from rounding (live tx: borrowed `35e18`, received `34.999999` USDC). `OnlyRepay` overpayment and failed `ft_transfer`s also land in *supplied*. Check `supplied[]` when reconciling. **Never pair `Borrow X` with `Withdraw {amount: X}`**: it fails at random when supplied is credited 1 unit short (sandbox-verified 2026-10-22). Use `Withdraw {max_amount: X}` or no amount.
8. **Omitting `amount` on Borrow.** With neither `amount` nor `max_amount` set, Borrow tries the whole pool liquidity. Always set `amount`.
9. **No storage on Burrow or on the token.** Register on Burrow (`storage_deposit`, ≥ 0.1 NEAR), and register the *receiving* account on each token contract. Otherwise the `Withdraw` ft_transfer fails and funds bounce back to Burrow *supplied*.
10. **Trusting `get_price_unsafe`, or a too-short max age.** It returned a much older `publish_time` than `get_price_no_older_than`. Burrow rejects prices older than 60 s. Use `age = 60`; a 30 s limit will often see `null`.
11. **HF from a different price than Burrow's.** Burrow truncates the Pyth price to `fraction_digits` (4 for NEAR/USDC). Burrow liquidates only when `HF < 1` *strictly*. Use a safety floor far above that (see `strategies.md`).
12. **Ignoring the cost of borrowing.** On 2026-10-22, native USDC utilization was about 94% and **borrow APR was 32.6%** (wNEAR supply APR 0.2%). Check `get_asset(...).borrow_apr` before looping.

## Reference index

- `references/actions.md`: registration, `ft_transfer_call` + every `TokenReceiverMsg`, `Action` enum JSON, amount semantics, `execute` vs `execute_with_pyth`, `simple_withdraw`, gas and deposits, deployed-vs-repo check. Answers vault-spec §12 items 1, 2, 7.
- `references/views-and-health.md`: view methods with live responses, oracle calls, decimals, the exact HF formula with a worked example and a Rust bps implementation, liquidation rules.
- `references/strategies.md`: leverage loop, max leverage math, unwind, reconcile, receipts and gas, safety thresholds, TypeScript (near-api-js 7.3.1) HF reader.

## Source abbreviations used in references

- `BL:` = ref-finance/burrowland @ `2110c7047f2d` (v0.15.7), path relative to `contracts/contract/src/` unless shown
- `BC:` = burrowHQ/burrow-cash (official frontend) @ `903a2885a47c` (2025-10-13)
- `GUIDE:` = ref-finance/guide (guide.rhea.finance source), `near-chain-guides/lending-and-borrowing/`
- `LIVE:` = view call on mainnet via `https://rpc.mainnet.fastnear.com`, 2026-10-22 (block ≈ 220,980,000)

## Sources (2026-10-22)

- Contract source: https://github.com/ref-finance/burrowland (main @ 2110c70, v0.15.7)
- Live contract: `contract.main.burrow.near` `get_version` = `"0.16.2"`, wasm hash `6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa`; `aggregate-oracle.near` `contract_source_metadata` → v0.4.1, repo `rhea-finance/agg-oracle` (not publicly reachable)
- Frontend: https://github.com/burrowHQ/burrow-cash
- Guide: https://guide.rhea.finance (health factor, liquidations, oracle pages)
- Exploit (secondary, no primary Rhea post-mortem found [VERIFY]): https://www.theblock.co/post/397961/rhea-finance-post-mortem-exploit-losses-18-4-million-double-initial-estimates, https://www.quillaudits.com/blog/hack-analysis/rhea-finance-hack

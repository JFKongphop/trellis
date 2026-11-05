# Strategies: leverage loop, unwind, reconcile, thresholds, TS reader

Prefixes as in SKILL.md. Message shapes are in `actions.md` and HF math is in `views-and-health.md`. Swaps (USDC↔wNEAR) belong to the `ref-dex-swaps` skill and appear here only as a step. Numbers marked *ours* are recommendations, not Burrow rules.

Notation: `k = vol(wNEAR) × vol(USDC) = 0.75 × 0.95 = 0.7125` (`LIVE: get_assets`). With wNEAR collateral `C` (USD) and USDC debt `D` (USD, USDC ≈ $1): **`HF = C·0.75 / (D/0.95) = k·C/D`**.

## 1. Max theoretical leverage

With equity `E`, the borrowed USDC is swapped into more wNEAR collateral, so `C = L·E`, `D = (L−1)·E`, and `HF = k·L/(L−1)`. Solving for leverage at a target HF `h`: **`L = 1 / (1 − k/h)`**. Because only NEAR moves, the price drop that takes you to HF 1 is `1 − 1/h`.

| target HF `h` | max leverage | NEAR drop to liquidation |
|---|---|---|
| 1.00 (Burrow limit) | **3.48×** (theoretical, liquidatable at once) | 0% |
| 1.10 | 2.84× | 9.1% |
| 1.25 | 2.33× | 20.0% |
| 1.35 | 2.12× | 25.9% |
| **1.50** | **1.90×** | **33.3%** |
| 1.60 | 1.80× | 37.5% |
| 2.00 | 1.55× | 50.0% |

Going the other way: 2.0× → HF 1.425, **2.5× → HF 1.19** (liquidation after a 16% NEAR drop), 3.0× → HF 1.07. **The earlier "demo cap ≈2.5×" idea is too aggressive. Cap at ≈1.8–1.9× (HF ≥ 1.5–1.6).** Swap fees and slippage lower all of these slightly.

**Carry cost (LIVE 2026-10-22):** USDC borrow APR 32.6%, wNEAR supply APR 0.2%. At 1.8× the debt is ≈0.8·E, so the drag is ≈26% of equity per year before any NEAR price move. Debt also grows ≈2.7%/month at that rate, so **HF decays ≈2.6%/month at a flat price**. Read `borrow_apr` before every loop step (guard: *ours*, refuse to add debt when `borrow_apr > max_borrow_apr`, e.g. 0.40).

## 2. Leverage loop (vault, one agent transaction per step)

Setup, once, by the owner or at vault init:
1. `contract.main.burrow.near.storage_deposit({"account_id":null,"registration_only":false})` with 0.15 NEAR attached.
2. `wrap.near.storage_deposit({"account_id":"<vault>"})` and `<usdc>.storage_deposit({"account_id":"<vault>"})`, so Burrow's `ft_transfer` to the vault can't fail.
3. Wrap NEAR if needed: `wrap.near.near_deposit()` with the NEAR attached.

Loop. Each step settles before the next (one in-flight lock):

| # | Step | Call | Price-dependent? |
|---|---|---|---|
| A | Supply wNEAR as collateral | `wrap.near.ft_transfer_call({receiver_id: BURROW, amount, msg: "\"OnlyIncreaseCollateral\""})`, 1 yocto | no, synchronous, refunds on panic |
| B | Borrow USDC to the vault | precheck (positions + 2 prices + projected HF ≥ floor), then `BURROW.execute_with_pyth({"actions":[{"Borrow":{"token_id":USDC,"amount":X}},{"Withdraw":{"token_id":USDC,"max_amount":X}}]})`, 1 yocto | yes. **Result not observable, reconcile (§4)** |
| C | Swap USDC → wNEAR | Ref deposit → swap → withdraw (`ref-dex-swaps`), `min_out` from oracle | yes (the vault's own check) |
| D | Supply the received wNEAR | same as A, with the *actual* amount received | no |

Borrow size for each iteration at target `h` (USD, then to inner units `× 10^18` for USDC): `X = C·k/h − D`. Example (`h = 1.6`, start 100 NEAR at $5.356, 0.5% swap loss):

| iter | borrow (USDC) | collateral after D (NEAR) | debt | HF after D | leverage |
|---|---|---|---|---|---|
| 1 | 238.51 | 144.31 | 238.51 | 2.31 | 1.45× |
| 2 | 105.68 | 163.94 | 344.19 | 1.82 | 1.65× |
| 3 | 46.83 | 172.64 | 391.01 | 1.68 | 1.73× |
| 4 | 20.75 | 176.49 | 411.76 | 1.64 | 1.77× |
| 5 | 9.19 | 178.20 | 420.96 | 1.62 | 1.79× |

- **The lowest HF in each iteration is right after step B** (= `h`, before the swapped NEAR is supplied). That's the value the vault's `min_health_factor_bps` check must cover. Stop after 3–4 iterations, since the remaining steps add little.
- Total per iteration ≈ 4 agent transactions (A/D, B, sync, C). A full 3-iteration loop is ≈ 10–12 transactions, so budget the agent's gas key accordingly.
- Never put `IncreaseCollateral` + `Borrow` in one `ExecuteWithPyth` ft msg (`actions.md` §2d: failure leaves the deposit as supplied, not refunded).

## 3. Deleverage and full unwind

Burrow checks **HF ≥ 1 right after DecreaseCollateral**, before you repay anything. So the amount of collateral you can pull per step is bounded:

`x_max (USD of NEAR) = C − D·f / k`, where `f` is the HF floor that must hold after the withdrawal (Burrow needs `f ≥ 1`; *ours*: use the vault's emergency floor, e.g. 1.15).

The closer HF is to `f`, the smaller each step, so deleverage early.

Deleverage step (repeat until HF ≥ target):
1. Withdraw collateral. Either:
   - `BURROW.simple_withdraw({"token_id":"wrap.near","amount_with_inner_decimal":"<x>","recipient_id":null})`, 1 yocto. **Returns a Promise whose final value is `bool`**, so the vault can `.then` on the real outcome (`BL:actions.rs:830-863`). Pass `recipient_id: null`, never an agent-provided account.
   - or `execute_with_pyth({"actions":[{"DecreaseCollateral":{"token_id":"wrap.near","amount":"<x>"}},{"Withdraw":{"token_id":"wrap.near","max_amount":"<x>"}}]})` + reconcile.
2. Swap wNEAR → USDC (`ref-dex-swaps`, oracle `min_out`).
3. Repay: `<usdc>.ft_transfer_call({receiver_id: BURROW, amount: <received>, msg: "\"OnlyRepay\""})`. Synchronous. Any surplus over the debt becomes *supplied* (`BL:actions_only.rs:69-90`).

Emergency paths that need no withdrawal (owner-signed or pre-funded): `OnlyRepay` with fresh USDC, or `OnlyIncreaseCollateral` with more wNEAR. Both are synchronous and price-free.

Full unwind:
1. Deleverage steps until the remaining debt can be repaid from one swap. Then `OnlyRepay` with `amount ≥ current debt + ~1 min of interest`. The frontend adds `interestChargedIn1min` (`BC:store/actions/repay.ts:50-58`). `amount ≥ full_repay_amount` repays **all** debt shares and removes the borrowed entry.
2. `execute({"actions":[{"Withdraw":{"token_id":USDC}}]})` (price-free) for the USDC surplus left as supplied.
3. With **zero debt**, `execute` (price-free, `compute_max_discount` returns early on no debt, `BL:actions.rs:762-764`): `{"actions":[{"DecreaseCollateral":{"token_id":"wrap.near"}},{"Withdraw":{"token_id":"wrap.near"}}]}`. No amounts = all collateral, then all supplied.
4. Optional: `storage_unregister` (1 yocto) requires empty supplied, positions and farms (`BL:storage.rs:200-222`).

## 4. Why every borrow needs reconcile

`execute_with_pyth` returns `()`. The oracle calls, `callback_execute_with_pyth`, `ft_transfer` and `after_ft_transfer` are **detached** from the caller's promise (`BL:actions_pyth.rs:30-47`). The vault's `.then` runs after receipt 1 succeeds, around the same block the oracle calls run. A view of Burrow issued from that callback races the Burrow callback. Possible outcomes:

| Outcome | Burrow debt | Burrow supplied[USDC] | vault `ft_balance_of(USDC)` | Cause |
|---|---|---|---|---|
| Success | +X | ≈ +1 inner unit dust | +X−1 ft unit | normal (`LIVE tx B85UPY8S…`) |
| Callback panicked | unchanged | unchanged | unchanged | stale/missing price, HF < 1, `borrowed_limit`, pool liquidity, delisted collateral, maintenance mode |
| Borrow ok, transfer failed | +X | +X | unchanged | vault not registered on the token / token paused (`after_ft_transfer` re-credits, `BL:fungible_token.rs:260-276`) |

Reconcile procedure (`sync_position`):
1. The worker waits for the agent's transaction to reach `FINAL`. RPC `tx` with `wait_until: "FINAL"` covers every receipt in the tree, including detached ones, ≈ 5–8 blocks.
2. In a **new** transaction, the vault joins `BURROW.get_account_all_positions(vault)` + `USDC.ft_balance_of(vault)` (+ prices) and compares them against the snapshot taken in the precheck.
3. Classify using the table. On "transfer failed", `execute([Withdraw USDC])` or `execute([Repay USDC])` from supplied. Settle reservations from **actual** deltas. Store HF. Unlock.

Use the same pattern for `execute_with_pyth` DecreaseCollateral. `simple_withdraw` and all `ft_transfer_call` flows (`OnlyIncreaseCollateral`, `OnlyRepay`) are directly observable.

## 5. Gas and receipts (vault-originated)

| Flow | Receipts (function calls) | Gas notes |
|---|---|---|
| Supply/Repay via `ft_transfer_call` | vault → token.ft_transfer_call → burrow.ft_on_transfer → token.ft_resolve_transfer → vault callback (4) | Frontend: 100 Tgas for the whole call (`BC:store/wallet.ts:32`). Forward ≥ 60 Tgas to the token [VERIFY sandbox] |
| Borrow (precheck + submit) | vault → {burrow.get_account_all_positions, oracle ×2} → vault.on_precheck → burrow.execute_with_pyth → oracle ×2 → burrow.callback → usdc.ft_transfer → burrow.after_ft_transfer, + vault.on_submitted (≈10) | Live Burrow side: 7.3 + 3.2/price + 16.7 + 2.4 + 3.2 Tgas burnt. The frontend attaches 300 Tgas. Forward **≥ 150 Tgas** to `execute_with_pyth` and keep the precheck ≤ ~80 Tgas to fit 300 [VERIFY sandbox] |
| `sync_position` | vault → {positions, ft_balance_of, oracle ×2} → vault.on_sync (≈5) | small |
| `simple_withdraw` (with debt) | burrow → oracle ×n → burrow.callback_simple_withdraw_with_pyth → token.ft_transfer → burrow.after_ft_transfer (result returned) | treat like borrow, ≥ 150 Tgas [VERIFY] |

Burrow static gas constants: oracle call 3 Tgas (`BL:pyth.rs:6`), extra_call 4 Tgas (`:8`), `ft_transfer` 10 Tgas + `after_ft_transfer` 10 Tgas (`BL:fungible_token.rs:7-8`), at most 20 price promises (`BL:pyth.rs:10`).

## 6. Safety thresholds (ours, for Trellis)

| Parameter | Value | Why |
|---|---|---|
| Loop target HF | **1.60** (≈1.8×) | 37.5% NEAR drop to liquidation; leaves room for interest decay |
| `min_health_factor_bps` (projected, any agent borrow/withdraw) | **15000** | 33% drop buffer. Matches the HF right after step B |
| Worker deleverage trigger | HF < **1.35** → deleverage back to 1.60 | 26% buffer left. A step still has `x_max > 0` above floor 1.15 |
| Emergency floor for deleverage withdrawals | **1.15** | Never let the vault's own withdrawal take HF near Burrow's 1.0 |
| Owner alert / full unwind | HF < **1.20** | |
| Price age | **60 s** (= Burrow) | Shorter often hits `null` (measured cadence ~30 s) |
| Price confidence | reject if `conf/price > 0.5%` | live values were 0.01–0.07% |
| Max borrow APR to add debt | e.g. **40%** (read `borrow_apr`) | USDC is at 94% utilization |
| Protocol state | `get_config.contract_mode == "Running"`, held tokens not in `get_delist_token_list` | 0.16.x controls |
| Burrow storage | keep `storage_balance_of.available ≥ 0.05 NEAR` | frontend rule (`BC:store/tokens.ts:179-184`) |
| Allowed tokens | `wrap.near`, native USDC only | avoids `extra_call` LST pricing and margin side doors |
| Allowed Burrow calls | `ft_transfer_call` with `OnlyIncreaseCollateral` / `OnlyRepay`, `execute` with Withdraw/Repay/DecreaseCollateral(no debt), `execute_with_pyth` with exactly `[Borrow, Withdraw]` or `[DecreaseCollateral, Withdraw]`, `simple_withdraw` with `recipient_id: null` | the vault builds the JSON; the agent passes only typed amounts |

The 1.35/1.5/1.6 values are judgment calls sized against NEAR's volatility, not Burrow rules. Revisit them with real volatility data.

## 7. TypeScript: read positions and HF (near-api-js 7.3.1)

Runs read-only against mainnet. Verified 2026-10-22 by running this exact code under Node 26 (as `.mts`): it printed `78598 Running []` for account `248d87e4…01b1`. That is HF 7.86, consistent with the Rust result of 78935 at the slightly different NEAR price a few minutes earlier. near-api-js v7 API: `new JsonRpcProvider({url})` and `provider.callFunction({contractId, method, args})` (package README and `lib/*.d.ts`, `CallFunctionArgs = {contractId, method, args, blockQuery?}`).

```ts
import { JsonRpcProvider } from "near-api-js"; // 7.3.1

const BURROW = "contract.main.burrow.near";
const ORACLE = "aggregate-oracle.near";
const provider = new JsonRpcProvider({ url: "https://rpc.mainnet.fastnear.com" });
const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction<T>({ contractId, method, args }) as Promise<T>;

type AssetView = { token_id: string; balance: string; shares: string; apr: string };
type Account = { supplied: AssetView[]; positions: Record<string, { collateral: AssetView[]; borrowed: AssetView[] }> };
type PythInfo = { decimals: number; fraction_digits: number; price_identifier: string;
                  extra_call: string | null; default_price: { multiplier: string; decimals: number } | null };
type PythPrice = { price: string; conf: string; expo: number; publish_time: number };

export async function readHealth(accountId: string) {
  // One call: [account, margin, assets, config, margin_config, -, -, pyth_infos]  (BL:lib.rs:307)
  const [acct, , , cfg, , , , pyth] = await view<any[]>(BURROW, "batch_views", {
    account_id: accountId, assets: false, config: true, margin_config: false,
    default_margin_base_token_limit: false, margin_base_token_limit: false, token_pyth_infos: true,
  });
  if (!acct) return null; // not registered on Burrow
  const pos = (acct as Account).positions?.REGULAR ?? { collateral: [], borrowed: [] };
  const tokens = [...new Set([...pos.collateral, ...pos.borrowed].map((a) => a.token_id))];
  if (pos.borrowed.length === 0) return { hfBps: null as number | null, pos, contractMode: cfg.contract_mode };

  const assets = await view<{ token_id: string; config: { volatility_ratio: number; extra_decimals: number } }[]>(
    BURROW, "get_assets", { token_ids: tokens });
  const cfgOf = Object.fromEntries(assets.map((a) => [a.token_id, a.config]));
  const infos = pyth as Record<string, PythInfo>;
  const ids = [...new Set(tokens.filter((t) => !infos[t].default_price).map((t) => infos[t].price_identifier))];
  const prices = ids.length
    ? await view<Record<string, PythPrice | null>>(ORACLE, "list_prices_no_older_than",
        { price_ids: ids, age: cfg.pyth_price_valid_duration_sec }) // 60
    : {};

  // Burrow price conversion, BL:pyth.rs:216-229
  const priceOf = (t: string) => {
    const info = infos[t];
    if (info.default_price) return { mult: BigInt(info.default_price.multiplier), dec: info.default_price.decimals };
    if (info.extra_call) throw new Error(`${t}: LST price needs ${info.extra_call}, not supported`);
    const p = prices[info.price_identifier];
    if (!p) throw new Error(`${t}: price missing or older than 60s`);
    const price = BigInt(p.price), fd = 10n ** BigInt(info.fraction_digits);
    const mult = p.expo < 0 ? (price * fd) / 10n ** BigInt(-p.expo) : price * 10n ** BigInt(p.expo) * fd;
    return { mult, dec: info.decimals + info.fraction_digits };
  };
  const usdE18 = (bal: string, t: string) => {
    const { mult, dec } = priceOf(t);
    return (BigInt(bal) * mult * 10n ** 18n) / 10n ** BigInt(dec + cfgOf[t].extra_decimals);
  };

  let adjC = 0n, adjD = 0n;
  for (const c of pos.collateral) adjC += (usdE18(c.balance, c.token_id) * BigInt(cfgOf[c.token_id].volatility_ratio)) / 10000n;
  for (const d of pos.borrowed) {
    const r = BigInt(cfgOf[d.token_id].volatility_ratio);
    adjD += (usdE18(d.balance, d.token_id) * 10000n + r - 1n) / r; // round debt up
  }
  return {
    hfBps: Number((adjC * 10000n) / adjD),           // 15000 = 1.5; Burrow liquidates below 10000
    adjCollateralUsdE18: adjC, adjDebtUsdE18: adjD,
    supplied: (acct as Account).supplied,             // leftovers / failed-transfer credits
    pos, contractMode: cfg.contract_mode as string,   // expect "Running"
  };
}
```
Notes:
- `list_prices_no_older_than` is an `aggregate-oracle.near` convenience method (`LIVE`). Burrow itself only calls `get_price_no_older_than`. The vault (Rust) should use `get_price_no_older_than(price_id, 60)` per token, the same interface as Burrow and `mock-pyth`.
- For the dashboard, convert `balance` to human units with `token_decimals + extra_decimals` (wNEAR 24, USDC 18).
- Signing (worker or frontend) isn't covered here. The agent never signs Burrow calls directly; it calls the vault's `agent_*` methods.

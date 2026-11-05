# Views, prices and the health factor

Source prefixes as in SKILL.md (`BL:` = burrowland @ 2110c70 `contracts/contract/src/`, `LIVE:` = mainnet 2026-10-22, block ≈ 220,980,000, via `https://rpc.mainnet.fastnear.com`).

Example RPC call, used for everything below:
```bash
ARGS=$(printf '%s' '{"account_id":"<acct>"}' | base64)
curl -s https://rpc.mainnet.fastnear.com -H 'Content-Type: application/json' -d '{
 "jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","finality":"final",
 "account_id":"contract.main.burrow.near","method_name":"get_account_all_positions","args_base64":"'$ARGS'"}}' \
 | jq -r '.result.result | implode'
```

## 1. Account views

`get_account_all_positions({"account_id"}) -> Option<AccountAllPositionsDetailedView>` (`BL:account.rs:262-266`, struct `BL:account_view.rs:67-80`). Returns `null` for an unregistered account (`LIVE`).

LIVE (`248d87e4…01b1`, a real wNEAR-collateral / USDC-debt account):
```json
{
  "account_id": "248d87e4b1d73b013eb8376052c27d11b6b5c096dec94c3fb28cb7d6f35d01b1",
  "supplied": [],
  "positions": {
    "REGULAR": {
      "collateral": [{"token_id":"wrap.near","balance":"115574481652220499315636554",
                      "shares":"109367742955136666742166987","apr":"0.002120448684100438834169059"}],
      "borrowed":   [{"token_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
                      "balance":"55880291060141767748","shares":"44768422812632856417",
                      "apr":"0.325786847383553202683491659"}]
    }
  },
  "farms": [{"farm_id":{"Supplied":"wrap.near"},"rewards":[]}],
  "has_non_farmed_assets": false, "booster_staking": null, "booster_stakings": {}, "is_locked": false
}
```
- Each asset entry is `AssetView {token_id, balance, shares, apr}` (`BL:account_view.rs:6-14`). **`balance` is an amount in inner decimals**, computed from shares at the current, interest-accrued pool state. `internal_get_asset` calls `asset.update(...)` on read (`BL:asset.rs:273-284`). Collateral `balance` rounds down and borrowed `balance` rounds up (`BL:account_view.rs:299-303`), the same as the HF math (`BL:position.rs:190,232`). `apr` is a decimal string.
- `positions` is a map keyed by position name. Regular lending uses **`"REGULAR"`** (`BL:utils.rs:30`). Other keys are LP-token "shadow" positions. **The key is absent until the account first collateralizes or borrows.**
- `supplied` = deposited but **not** collateral. It doesn't count for HF.
- `get_account({"account_id"})` (`BL:account.rs:254-258`): same data flattened to `supplied/collateral/borrowed` for REGULAR only, and no `is_locked`.
- `get_accounts_paged` / `list_accounts` return the raw `Account` with **shares only** (`{"supplied":{"wrap.near":"<shares>"},"positions":{"REGULAR":{"RegularPosition":{"collateral":{…},"borrowed":{…}}}}}`). Don't use these for balances.
- `batch_views({"account_id", "assets", "config", "margin_config", "default_margin_base_token_limit", "margin_base_token_limit", "token_pyth_infos"})` (`BL:lib.rs:307-330`) returns an 8-tuple `[account_all_positions, margin_account, assets_detailed, config, margin_config, …, token_pyth_infos]` in **one RPC call**. Pass `false` for the parts you don't need. `LIVE` confirmed.
- `storage_balance_of({"account_id"})` → `{"total","available"}`. LIVE: `{"total":"200000000000000000000000","available":"100000000000000000000000"}`.

## 2. Asset views

`get_asset({"token_id"})`, `get_assets({"token_ids":[…]})` (`BL:asset.rs:334-349`), `get_assets_paged_detailed({"from_index","limit"})`. Fields (`BL:asset_view.rs:6-46`): `supplied{shares,balance}`, `borrowed{shares,balance}`, `margin_debt`, `reserved`, `prot_fee`, `config`, `supply_apr`, `borrow_apr`, `farms`, …
- Paging bug: `get_assets_paged*` iterate `from_index..min(len, limit)`, not `from_index + limit` (`BL:asset.rs:359,376`). Use `get_assets` with explicit ids.

LIVE (abbreviated):
```json
[{"token_id":"wrap.near",
  "supplied":{"balance":"3501426091818205523678737303283"},"borrowed":{"balance":"493202772151154552704273892131"},
  "config":{"volatility_ratio":7500,"extra_decimals":0,"can_deposit":true,"can_withdraw":true,
            "can_use_as_collateral":true,"can_borrow":true,
            "supplied_limit":"10000000000000000000000000000000","borrowed_limit":"610000000000000000000000000000",
            "min_borrowed_amount":"1000000000000000"},
  "supply_apr":"0.002120448506127182379800568","borrow_apr":"0.020071781546908246920296867"},
 {"token_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "supplied":{"balance":"12408822756707770710643938"},"borrowed":{"balance":"11712737696810658633013303"},
  "reserved":"200002851391639234112802",
  "config":{"volatility_ratio":9500,"extra_decimals":12,"can_use_as_collateral":true,"can_borrow":true,
            "supplied_limit":"60000000000000000000000000","borrowed_limit":"25000000000000000000000000",
            "min_borrowed_amount":"1000000000"},
  "supply_apr":"0.23063333235012571344222567","borrow_apr":"0.325786417830207706760076982"}]
```
Reading it: about 3.50M wNEAR supplied / 0.49M borrowed. USDC 12.41M supplied / 11.71M borrowed, **≈94% utilization, 32.6% borrow APR**. Pool liquidity you can borrow or withdraw = `supplied + reserved + prot_fee − borrowed − margin_debt − margin_pending_debt` (`BL:asset.rs:233-240`), ≈ 0.9M USDC here. `min_borrowed_amount` isn't enforced on the regular Borrow path in v0.15.7 (only referenced in config/legacy) [VERIFY for 0.16.2].

`AssetConfig` docs (`BL:asset_config.rs:55-66`): `volatility_ratio` in bps (10000 = 100%) is the collateral factor *and* the debt divisor. `extra_decimals` is added to the token decimals to form inner decimals.

## 3. Config and price metadata

`get_config()` (`BL:config.rs:11-79`). LIVE:
```json
{"oracle_account_id":"priceoracle.near","pyth_oracle_account_id":"aggregate-oracle.near",
 "ref_exchange_id":"v2.ref-finance.near","owner_id":"burrow.sputnik-dao.near","max_num_assets":20,
 "pyth_price_valid_duration_sec":60,"force_closing_enabled":true,
 "enable_price_oracle":false,"enable_pyth_oracle":true,
 "contract_mode":"Running","dcl_id":"dclv2.ref-labs.near","pause_operator_id":null, "...": "…"}
```
(`contract_mode` and `pause_operator_id` exist only in 0.16.x.)

`get_all_token_pyth_infos()` / `get_token_pyth_info({"token_id"})` (`BL:lib.rs:225-232`, struct `BL:pyth.rs:24-30`). LIVE (selected):
```json
{"wrap.near":{"decimals":24,"fraction_digits":4,"price_identifier":"c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750","extra_call":null,"default_price":null},
 "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1":{"decimals":6,"fraction_digits":4,"price_identifier":"eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a","extra_call":null,"default_price":null},
 "usdt.tether-token.near":{"decimals":6,"fraction_digits":4,"price_identifier":"2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b","extra_call":null,"default_price":null},
 "meta-pool.near":{"decimals":24,"fraction_digits":4,"price_identifier":"c415de8d…e226750","extra_call":"get_st_near_price","default_price":null},
 "a663b02cf0a4b149d2ad41910cb81e23e1c41c32.factory.bridge.near":{"…":"…","default_price":{"multiplier":"1","decimals":20}}}
```
- `decimals` = token ft decimals. `fraction_digits` = how many decimals of the USD price Burrow keeps.
- `extra_call` (LSTs) multiplies the NEAR price by the token's exchange rate. **Keep the vault's allowlist to wNEAR + USDC** so this never applies.
- `default_price` tokens never call the oracle.
- Hardcode the price ids in the vault (checked at init against this view) rather than trusting agent input.

`get_last_prices()` (`BL:lib.rs:303-305`) holds the last prices Burrow *used*, in Burrow format, e.g. `"wrap.near":{"multiplier":"53576","decimals":28}`. They are updated only when someone runs a priced action. **Not a freshness source**, so don't use it for HF.

## 4. Oracle: `aggregate-oracle.near` (v0.4.1)

Interface Burrow uses (`BL:pyth.rs:16-19`):
```rust
fn get_price_no_older_than(&self, price_id: PriceIdentifier, age: u64) -> Option<Price>;
// PriceIdentifier = 64-char lowercase hex string in JSON (BL:pyth.rs:50-96)
// Price/PythPrice JSON: {"price": I64 string, "conf": U64 string, "expo": i32, "publish_time": i64 unix seconds} (BL:pyth.rs:36-44)
```
LIVE:
```text
get_price_no_older_than {"price_id":"c415de8d…e226750","age":60}
  → {"price":"535607420","conf":"368272","expo":-8,"publish_time":1792606188}      # NEAR = $5.35607420
get_price_no_older_than {"price_id":"eaa020c6…a9e9c94a","age":60}
  → {"price":"99997445","conf":"65888","expo":-8,"publish_time":1792606188}        # USDC = $0.99997445
get_price_no_older_than {"price_id":"c415…","age":5}       → null   (stale relative to that window)
get_price_no_older_than {"price_id":"00…01","age":60}      → null   (unknown id: null, no panic)
get_price {"price_identifier":"c415…"}                     → same shape, no age filter
list_prices_no_older_than {"price_ids":[…],"age":60}       → {"<id>": Price | null, …}   (one call, many ids)
get_price_unsafe {"price_identifier":"eaa0…"}               → publish_time 1792193086 (~4.8 days older than get_price!) - don't use
```
- Argument names differ: `get_price_no_older_than` takes **`price_id`**, while `get_price`/`get_price_unsafe` take **`price_identifier`**.
- Measured update cadence: `publish_time` advanced every ~30 s. At `finality: final`, prices were 19–45 s old. **Use `age = 60`** (Burrow's `pyth_price_valid_duration_sec`). Burrow re-checks `publish_time + 60 s >= block_timestamp` in its callback (`BL:pyth.rs:190`).
- Burrow ignores `conf`. The vault may additionally reject `conf * 10_000 / price > max_conf_bps`. Live conf was 0.01–0.07% of price.
- `contract_source_metadata` → repo `github.com/rhea-finance/agg-oracle` @ `ba866eb`, **not publicly reachable**. How it aggregates and who pushes prices is unknown [VERIFY]. Treat it as a black box with a Pyth-compatible interface.
- Cross-contract: `ext_pyth::ext(oracle).with_static_gas(Gas::from_tgas(3)).get_price_no_older_than(id, 60)` exactly as Burrow does (`BL:pyth.rs:125-128`). Any caller works (answers vault-spec §12 item 7).
- Sandbox: `contracts/mock-pyth` exposes `set_price`, `get_price`, `get_price_no_older_than(price_id, age)`, but **ignores `age`** (`BL:../mock-pyth/src/lib.rs:95-102`). Test staleness with your own mock.

### Pyth price → Burrow price (decimals)
```rust
// BL:pyth.rs:216-229
multiplier = floor( price * 10^expo * 10^fraction_digits )   // BigDecimal, then round_down
decimals   = token_info.decimals + token_info.fraction_digits
```
NEAR: `floor(535607420 / 1e8 * 1e4)` = **53560**, decimals 24+4 = **28**. USDC: `floor(99997445/1e4)` = **9999**, decimals 6+4 = **10**.

USD value of an inner balance (`BigDecimal::from_balance_price`, `BL:big_decimal.rs:208-216`):
```
value_usd = balance_inner * multiplier / 10^(price.decimals + extra_decimals)
```
(`price.decimals + extra_decimals` = token decimals + extra + fraction_digits = inner decimals + fraction_digits.)

## 5. Health factor, exactly as Burrow computes it

```rust
// BL:position.rs:182-198 (collateral) and 224-239 (borrowed)
collateral_sum = Σ from_balance_price(supplied.shares_to_amount(coll_shares, false), price, extra).mul_ratio(volatility_ratio)
borrowed_sum   = Σ from_balance_price(borrowed.shares_to_amount(debt_shares, true), price, extra).div_ratio(volatility_ratio)
// BL:big_decimal.rs:200-206: mul_ratio(r) = x*r/10000 (round half up); div_ratio(r) = x*10000/r (round half up)
// BL:actions.rs:760-778
compute_max_discount = if no borrowed { 0 } else if borrowed_sum <= collateral_sum { 0 }
                       else { (borrowed_sum - collateral_sum) / borrowed_sum / 2 }
```
So **HF = collateral_sum / borrowed_sum** = `Σ coll_usd·vol_c / Σ (debt_usd / vol_d)` with vol in [0,1]. This matches `GUIDE:how-lending-and-borrowing-works/health-factor.md` ("collateral_factor is also named volatility_ratio").
- Burrow has **no HF view**. It only enforces `HF ≥ 1` after Borrow/DecreaseCollateral (`BL:actions.rs:279-281`).
- Liquidatable iff `HF < 1` strictly. `HF == 1` is safe.
- Only the REGULAR position matters for a plain lending account, and all of its collateral and borrowed tokens count.

### Worked example (LIVE numbers above)

| | wNEAR collateral | USDC debt |
|---|---|---|
| inner balance | 115574481652220499315636554 (115.5745 NEAR) | 55880291060141767748 (55.8803 USDC) |
| Burrow price | 53560 / 10^28 → $5.3560 | 9999 / 10^(10+12) → $0.9999 |
| USD value | 619.0169 | 55.8747 |
| vol ratio | ×0.75 → **464.2627** | ÷0.95 → **58.8155** |

HF = 464.2627 / 58.8155 = **7.8935** → `hf_bps = 78935` (Rust and TS implementations below both produce this). Since HF scales linearly with the NEAR price here, liquidation starts at NEAR ≈ 5.356 / 7.8935 = **$0.68**.

### Rust: HF in bps (near-sdk 5, checked math, matches Burrow rounding conservatively)

Tested off-chain with `uint = 0.9.5` (the version Burrow uses); output `hf_bps=78935` for the example.
```rust
uint::construct_uint! { pub struct U256(4); }   // uint = { version = "0.9.5", default-features = false }

pub struct PythPrice { pub price: i64, pub conf: u64, pub expo: i32, pub publish_time: i64 }
pub struct TokenMeta { pub decimals: u8, pub extra_decimals: u8, pub fraction_digits: u8, pub volatility_ratio: u32 }
pub struct Line { pub inner_balance: u128, pub meta: TokenMeta, pub price: PythPrice }

const BPS: u32 = 10_000;

/// Burrow-equivalent price: (multiplier, decimals). BL:pyth.rs:216-229
fn burrow_price(p: &PythPrice, m: &TokenMeta) -> Option<(U256, u32)> {
    if p.price <= 0 { return None; }
    let mut mult = U256::from(p.price as u64).checked_mul(U256::exp10(m.fraction_digits as usize))?;
    if p.expo >= 0 { mult = mult.checked_mul(U256::exp10(p.expo as usize))?; }
    else { mult = mult / U256::exp10(p.expo.unsigned_abs() as usize); }          // round down like Burrow
    Some((mult, m.decimals as u32 + m.fraction_digits as u32))
}

/// USD value scaled 1e18. BL:big_decimal.rs:208-216
fn value_e18(l: &Line) -> Option<U256> {
    let (mult, dec) = burrow_price(&l.price, &l.meta)?;
    let num = U256::from(l.inner_balance).checked_mul(mult)?.checked_mul(U256::exp10(18))?;
    Some(num / U256::exp10((dec + l.meta.extra_decimals as u32) as usize))
}

/// Returns None on bad input (caller must fail closed). u32::MAX when there is no debt.
pub fn health_factor_bps(collateral: &[Line], debt: &[Line]) -> Option<u32> {
    let mut adj_c = U256::zero();
    for l in collateral {
        let v = value_e18(l)?.checked_mul(U256::from(l.meta.volatility_ratio))? / U256::from(BPS); // round down
        adj_c = adj_c.checked_add(v)?;
    }
    let mut adj_d = U256::zero();
    for l in debt {
        if l.meta.volatility_ratio == 0 { return None; }
        let r = U256::from(l.meta.volatility_ratio);
        let v = (value_e18(l)?.checked_mul(U256::from(BPS))?.checked_add(r - 1)?) / r;             // round up
        adj_d = adj_d.checked_add(v)?;
    }
    if adj_d.is_zero() { return Some(u32::MAX); }
    let hf = adj_c.checked_mul(U256::from(BPS))? / adj_d;
    Some(if hf > U256::from(u32::MAX) { u32::MAX } else { hf.as_u32() })
}
```
Usage in the vault:
- **Inputs:** `inner_balance` = the `balance` strings from `get_account_all_positions().positions.REGULAR`. `volatility_ratio`/`extra_decimals` come from `get_assets` (cache at init, refresh on `sync_position`). `decimals`/`fraction_digits` come from `get_token_pyth_info`. Prices come from `get_price_no_older_than(id, 60)`, with an extra freshness check against `env::block_timestamp()`.
- **Projected HF for a borrow of `x` inner units of token T:** add `x` to T's debt line, or insert a line if it's absent. **Projected HF for withdrawing collateral:** subtract from the collateral line. If a projected collateral line would go negative, reject.
- Overflow headroom: `inner_balance` ≤ ~1e33 × multiplier ≤ ~1e9 × 1e18 ≈ 1e60 < U256 max (1.1e77).
- Rounding differs from Burrow by at most a few wei of USD. The vault rounds against itself (collateral down, debt up), so its HF ≤ Burrow's.

## 6. Liquidation rules

Source: `BL:actions.rs:594-681` (`internal_liquidate`), `:683-758` (`internal_force_close`), `GUIDE:how-lending-and-borrowing-works/liquidations.md`.
1. Anyone (except the account itself, `:192-195`) sends `Liquidate {account_id, in_assets, out_assets}` via `execute_with_pyth` or `ft_transfer_call` with `ExecuteWithPyth`. The target must have `max_discount > 0`, i.e. **HF < 1** (`:606-610`).
2. `discount = (1 − HF) / 2` (`:773`, guide). Example: HF 0.875 → 6.25%.
3. The liquidator repays `in_assets` (debt) and takes `out_assets` (collateral) with `taken_value × (1 − discount) ≤ repaid_value` (`:650-656`). Values here are **raw USD, without volatility ratios**.
4. Afterwards the target must **still have HF < 1** and a **smaller discount than before** (`:658-667`). Liquidations are partial, and liquidators compete on size. There's no fixed close factor or bonus: the bonus grows as HF falls.
5. **Force close** (`force_closing_enabled: true` LIVE): if the *raw* borrowed sum exceeds the raw collateral sum (bad debt), anyone can wipe the position and the reserves absorb the loss (`:683-758`). The owner loses all collateral.
6. 0.16.x adds `contract_mode = RunningWithoutPublicLiquidation` (liquidation restricted to a whitelist [VERIFY]) and `liq_benefit_protocol_rate`/`liq_benefit_liquidator_rate` (5000/5000 in `get_margin_config`; whether this applies to regular liquidations is unknown [VERIFY]).

What this means for us: a wNEAR/USDC position liquidates when `NEAR_price < entry_price × (1 / HF_now)`. Each liquidation step takes collateral at `discount = (1−HF)/2` off the oracle price, so dropping from HF 0.9 costs the owner about 5% on the liquidated slice. The vault's deleverage trigger must fire well before HF 1.0. See `strategies.md` §5.

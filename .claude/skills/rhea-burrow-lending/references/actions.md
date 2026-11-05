# Burrow actions: exact shapes

Source prefixes: `BL:` = burrowland @ 2110c70 (v0.15.7) `contracts/contract/src/`, `BC:` = burrow-cash frontend @ 903a288, `LIVE:` = mainnet RPC 2026-10-22. Deployed contract is **v0.16.2** (source not public). Every method and variant below was confirmed in the deployed wasm's export list or embedded serde variant strings (see "Deployed vs repo" at the end).

## 0. Units

- **Inner decimals** = `ft_metadata.decimals + asset.config.extra_decimals`. Every `amount`/`max_amount` in an `Action`, every view `balance`, and `simple_withdraw.amount_with_inner_decimal` uses inner units.
- `ft_transfer_call.amount` uses the token's own units. Burrow converts: `amount = amount.0 * 10^extra_decimals` (`BL:fungible_token.rs:47`).
- On withdraw, Burrow sends `ft_amount = inner_amount / 10^extra_decimals` (rounded down, `BL:actions.rs:351`). The truncated remainder is burned from your shares, so withdraw in whole token units: an inner amount divisible by `10^extra`.
- wNEAR: extra 0 → inner = yocto (1e24). USDC (native `17208628…33a1`): extra 12 → 1 USDC = `1e6` ft = `1e18` inner (`LIVE: get_assets`).

## 1. Registration / storage

```rust
// BL:storage.rs:9
const MIN_STORAGE_BALANCE: Balance = 10000u128 * env::STORAGE_PRICE_PER_BYTE;   // = 0.1 NEAR
```
- `storage_deposit(account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance`, payable (`BL:storage.rs:129-175`). The first deposit must be **≥ 0.1 NEAR**, or it panics "The attached deposit is less than the mimimum storage balance" (`:148-151`). Creating the account also creates an empty margin account (`:172`).
- `LIVE: storage_balance_bounds` → `{"min":"100000000000000000000000","max":null}`.
- Storage is checked on every account write (`assert_storage_covered`, `BL:storage.rs:71-89`). The official frontend deposits **0.15 NEAR** and tops up with another deposit when `available < 0.05 NEAR` (`BC:store/constants.ts:56-57`, `BC:store/tokens.ts:156-185`). A live account holding one collateral and one borrow used 0.01267 NEAR (`LIVE: get_storage_balance_of_detail` → `{"deposit_amount":"200000000000000000000000","min_deposit_amount":"100000000000000000000000","used_amount":"12670000000000000000000"}`).
- Vault recommendation: `storage_deposit({"account_id": null, "registration_only": false})` with **0.15 NEAR** attached, once at vault init.
- Separately, the **vault must be registered on each token contract it receives** (`wrap.near`, USDC). Withdraw/Borrow sends `ft_transfer` to the vault. If that fails, `after_ft_transfer` re-credits Burrow *supplied* (`BL:fungible_token.rs:260-276`) and the vault's FT balance doesn't change.
- `max_num_assets` = 20 (`LIVE: get_config`) counts collateral + borrowed entries (`BL:account.rs:174-185`).

## 2. Supply via `ft_transfer_call`

Call the **token contract**: `ft_transfer_call({receiver_id: "contract.main.burrow.near", amount: "<ft units>", msg: "<see below>"})`, 1 yoctoNEAR attached. The frontend uses 100 Tgas total (`BC:store/wallet.ts:32`). From a contract, give the `ft_transfer_call` ≥ 60 Tgas [VERIFY in sandbox].

`ft_on_transfer` (`BL:fungible_token.rs:31-143`):
- Requires `asset.config.can_deposit` (`:42-45`).
- `msg.is_empty()` → plain deposit to *supplied* (`:49-50`).
- Otherwise `serde_json::from_str::<TokenReceiverMsg>(&msg)`, panicking "Can't parse TokenReceiverMsg" (`:52-53`).
- **Always returns `U128(0)`** (all tokens used, `:142`). On a panic inside `ft_on_transfer`, the token's `ft_resolve_transfer` refunds the full amount. The vault's `on_supply_done` therefore sees either `amount` (success) or a refund (panic). There is no partial use.

```rust
// BL:fungible_token.rs:13-23
pub enum TokenReceiverMsg {
    Execute { actions: Vec<Action> },
    ExecuteWithPyth { actions: Vec<Action> },
    DepositToReserve,
    DepositToMargin,                              // margin, don't use
    MarginExecute { actions: Vec<MarginAction> }, // margin, don't use
    MarginExecuteWithPyth { actions: Vec<MarginAction> },
    SwapReference { swap_ref: SwapReference },    // only callable by Ref/DCL/owner
    OnlyIncreaseCollateral,
    OnlyRepay,
}
```

Serde shape: externally tagged. Unit variants are a **JSON string** (`"OnlyRepay"`) or `{"OnlyRepay":null}`. The `msg` argument is a *string containing JSON*, so the quotes are part of the message. Checked by compiling the same enum with serde_json 1.0: `"OnlyRepay"` OK, `{"OnlyRepay":null}` OK, bare `OnlyRepay` → error, `{"OnlyRepay":{}}` → error.

### 2a. Supply only (not collateral, doesn't count for HF)
```json
{ "receiver_id": "contract.main.burrow.near", "amount": "1000000000000000000000000", "msg": "" }
```

### 2b. Supply as collateral, preferred: `OnlyIncreaseCollateral`
```json
{ "receiver_id": "contract.main.burrow.near", "amount": "1000000000000000000000000", "msg": "\"OnlyIncreaseCollateral\"" }
```
- `BL:actions_only.rs:5-52`. The transferred amount goes **straight to REGULAR collateral**. Existing *supplied* is untouched. Checks `can_use_as_collateral`, `supplied.balance + amount <= supplied_limit` (`:18-23`), account not locked, and asset count.
- Synchronous. Any panic → full refund.
- Rust (near-sdk 5): `let msg = "\"OnlyIncreaseCollateral\"".to_string();`
- **Answers vault-spec §12 item 1 (collateral).** This is the exact supply-as-collateral msg. The spec's draft `{"Execute":{"actions":[{"IncreaseCollateral":{"token_id":token}}]}}` also parses (`amount`/`max_amount` default to `None`). With both `None`, though, it collateralizes **all** of the vault's supplied balance of that token (`BL:actions.rs:806-810`), not only this transfer. Use `OnlyIncreaseCollateral`, or set `max_amount`.

### 2c. Supply as collateral via `Execute` (what the official UI sends)
```json
{"Execute":{"actions":[{"IncreaseCollateral":{"token_id":"wrap.near","max_amount":"1000000000000000000000000"}}]}}
```
`BC:store/actions/supply.ts:46-55,78-85` (`max_amount` = ft amount × 10^extra, rounded down). Synchronous: `internal_execute` with empty prices (`BL:fungible_token.rs:138`). IncreaseCollateral has no risk check (`BL:actions.rs:109-115`).

### 2d. `ExecuteWithPyth` (avoid inside ft_transfer_call)
```json
{"ExecuteWithPyth":{"actions":[{"IncreaseCollateral":{"token_id":"wrap.near","max_amount":"1000000000000000000000000"}},{"Borrow":{"token_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","amount":"5000000000000000000"}}]}}
```
`ft_on_transfer` deposits, commits state, and starts oracle promises + `callback_execute_with_pyth`. It returns 0 right away (`BL:fungible_token.rs:132-142`, `BL:actions_pyth.rs:30-47`). **If the callback panics (stale price, HF < 1, liquidity), the deposit stays as plain *supplied* and is not refunded.** The token reports full use. Only use this when that failure mode is acceptable and you reconcile afterwards.

### 2e. Repay: `OnlyRepay` (preferred for repay)
```json
{ "receiver_id": "contract.main.burrow.near", "amount": "5000000", "msg": "\"OnlyRepay\"" }
```
- `BL:actions_only.rs:55-98`, available since v0.15.6 and present in the deployed wasm.
- If `amount >= current debt` (rounded up), it repays the **full** debt and the **rest is deposited to *supplied*** (`:69-90`). That remainder isn't refunded: withdraw it with `execute([Withdraw])`.
- If the account has no position → panic "Position not found". If it has no borrow of that token → panic "Borrowed asset not found" (`BL:account.rs:104-108` → `BL:position.rs:163-177`). Either way the transfer is fully refunded.
- Synchronous. Doesn't touch existing supplied balance or collateral.
- **Answers vault-spec §12 item 1 (repay).**

### 2f. Repay via `Execute` (official UI)
```json
{"Execute":{"actions":[{"Repay":{"token_id":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","max_amount":"5000000000000000000"}}]}}
```
`BC:store/actions/repay.ts:84-100`: `max_amount` is omitted for "repay all". The deposit first goes to *supplied*, then Repay draws from supplied shares (`BL:actions.rs:466-484, 507-547`). Any leftover stays *supplied*.

### 2g. `DepositToReserve`
Donates to the protocol reserve. Never use it.

## 3. `Action` enum

```rust
// BL:actions.rs:8-16
pub struct AssetAmount {
    pub token_id: TokenId,
    pub amount: Option<U128>,      // exact amount (inner decimals)
    pub max_amount: Option<U128>,  // cap; used only if `amount` is None
}
// BL:actions.rs:21-65 (only the regular-position variants are relevant)
pub enum Action {
    Withdraw(AssetAmount),
    IncreaseCollateral(AssetAmount),
    DecreaseCollateral(AssetAmount),
    Borrow(AssetAmount),
    Repay(AssetAmount),
    // also: ClientEchoWithdraw{..} (whitelisted senders only), Position*{position, asset_amount} (LP shadow positions),
    // Liquidate{..}, ForceClose{..}, LiquidateMTPositionDirect{..}
}
```
Serde: newtype variants → `{"Borrow":{"token_id":"…","amount":"…"}}`. Missing `amount`/`max_amount` is fine (Option). Amounts are decimal strings.

**Amount resolution** (`asset_amount_to_shares`, `BL:actions.rs:781-815`):
- `amount: Some(a)` → exactly `a`.
- else `max_amount: Some(m)` → `min(available_shares, shares(m))`, so at most `m` and at most what's available.
- else → **all** `available_shares`.
- Panics if the resulting shares or amount is 0 ("Shares can't be 0" / "Amount can't be 0").

What `available_shares` means for each action:

| Action | JSON | "available" | Notes / source |
|---|---|---|---|
| Withdraw | `{"Withdraw":{"token_id":"wrap.near","max_amount":"1000000000000000000000000"}}` | your *supplied* shares (not collateral) | **Silently skipped if you have no supplied entry for the token** (`:86`). Also needs `can_withdraw` and `amount <= pool available_amount`, else "Withdraw error: Exceeded available amount" (`:326-362`). An `amount` larger than your supplied → "Not enough asset balance". Sends `ft_transfer` (10 Tgas static) + `after_ft_transfer` (`BL:fungible_token.rs:166-192`). |
| IncreaseCollateral | `{"IncreaseCollateral":{"token_id":"wrap.near","max_amount":"…"}}` | supplied shares | Moves supplied → collateral. Needs `can_use_as_collateral` and supply limit (`:364-396`). No risk check. |
| DecreaseCollateral | `{"DecreaseCollateral":{"token_id":"wrap.near","amount":"…"}}` | collateral shares | Moves collateral → supplied. **Adds a risk check** (`:126-140, 279-281`). Needs prices if any debt exists. |
| Borrow | `{"Borrow":{"token_id":"<usdc>","amount":"5000000000000000000"}}` | **pool liquidity** (`available_amount`) | **Always set `amount`.** Leaving it out tries to borrow the whole pool. Credits the borrowed amount to your **supplied** (`:418-464`). Checks `can_borrow`, `borrowed_limit`, then the risk check. |
| Repay | `{"Repay":{"token_id":"<usdc>","max_amount":"…"}}` | your **borrowed** shares | Pays from your *supplied* of that token. If supplied < needed, caps at supplied (asserting `>= amount` when `amount` is set) (`:507-547`). Omitting both repays the full debt. |

**Risk check** (`BL:actions.rs:279-281`): after all actions, for each position touched by Borrow/DecreaseCollateral: `assert!(compute_max_discount(...) == 0)`, i.e. `borrowed_sum_adj <= collateral_sum_adj` (**HF ≥ 1.0**). The whole batch is atomic: one panic reverts every action in that receipt.

Canonical batches (all sent to `contract.main.burrow.near`):
```jsonc
// borrow USDC and send it to me (BC:store/actions/borrow.ts:53-71)
{"actions":[{"Borrow":{"token_id":"<usdc>","amount":"5000000000000000000"}},
            {"Withdraw":{"token_id":"<usdc>","max_amount":"5000000000000000000"}}]}
// withdraw collateral (BC:store/actions/withdraw.ts:98-150)
{"actions":[{"DecreaseCollateral":{"token_id":"wrap.near","amount":"1000000000000000000000000"}},
            {"Withdraw":{"token_id":"wrap.near","max_amount":"1000000000000000000000000"}}]}
// withdraw leftover supplied (e.g. after OnlyRepay overpay): price-free
{"actions":[{"Withdraw":{"token_id":"<usdc>"}}]}
```
Live example (`B85UPY8Su9s8mYyMqUPoXZuR9CpZUKBJcWctvwQb1Vom`): Borrow `amount 35000000000000000000` + Withdraw `max_amount 35000000000000000000` → `borrow` event 35e18, `withdraw_started` **34999999999999999999**, ft_transfer **34999999** (34.999999 USDC). Share rounding leaves 1 inner unit plus the extra-decimals truncation behind. Expect `received ≈ requested − 1 ft unit`.

## 4. `execute` vs `execute_with_pyth`

```rust
// BL:actions.rs:821-828
#[payable] pub fn execute(&mut self, actions: Vec<Action>)            // assert_one_yocto, Prices::new()
// BL:actions_pyth.rs:10-17
#[payable] pub fn execute_with_pyth(&mut self, actions: Vec<Action>)  // assert_one_yocto, returns ()
```
Both take `{"actions":[ … ]}`, need **exactly 1 yoctoNEAR**, and act for `predecessor_account_id` (the vault contract itself, so no special permission is needed).

**Which actions need prices.** `involved_tokens` (`BL:actions_pyth.rs:49-98`):
- `Borrow` → the borrowed token + every collateral/borrowed token in REGULAR.
- `DecreaseCollateral` → every token in REGULAR.
- `IncreaseCollateral` → its token, only if no REGULAR position exists yet *and* the batch also contains a Borrow.
- `Withdraw`, `Repay`, `IncreaseCollateral` alone → none.

With `execute`, a Borrow or a DecreaseCollateral **while debt exists** panics "Asset … price is missing" (`BL:prices.rs:23-25`, via `BL:position.rs:182-239`). With no debt, `compute_max_discount` returns 0 early (`BL:actions.rs:762-764`), so DecreaseCollateral works under plain `execute`.

| Operation | Method |
|---|---|
| Withdraw supplied, Repay from supplied, IncreaseCollateral | `execute` |
| DecreaseCollateral with **no** debt | `execute` |
| Borrow, DecreaseCollateral with debt | `execute_with_pyth` |

**How `execute_with_pyth` runs** (`BL:actions_pyth.rs:30-47`, `BL:pyth.rs`):
1. Receipt 1 (`execute_with_pyth`): for each involved token without `default_price`, call `aggregate-oracle.near.get_price_no_older_than(price_id, 60)` with 3 Tgas static each (`BL:pyth.rs:6,125-128`), at most 20 promises (`:10,160`). LST tokens also call their `extra_call` (4 Tgas). These are joined with `.and()` and `.then(callback_execute_with_pyth)`. **The promise is not returned** (`fn … ` returns `()`).
2. Callback: every price must be `Some`, `price > 0`, and `publish_time + 60 s >= block_timestamp`, else panic "… publish_time is too stale" (`BL:pyth.rs:168-203`, line 190). Then `internal_execute` runs with those prices. Burrow does **not** check `conf`.
3. Withdraw → `ft_transfer` → `after_ft_transfer`.

Consequence for the vault: a `.then(on_borrow_submitted)` on `execute_with_pyth` fires after receipt 1 succeeds, **before** the callback has run. Success there means only "submitted". Reconcile in a *later* transaction (see `strategies.md` §4).

**Gas.** Live borrow tx (`B85UPY8S…`, 300 Tgas attached, 4 price/extra calls): `execute_with_pyth` 7.3 Tgas, each oracle call ≈ 3.2, `callback_execute_with_pyth` 16.7, `ft_transfer` 2.4, `after_ft_transfer` 3.2. The frontend attaches **300 Tgas** (`BC:store/actions/borrow.ts:103`). From a contract, forward **≥ 150 Tgas** to `execute_with_pyth` for a wNEAR/USDC position (2 oracle calls) [VERIFY with sandbox gas profiling]. The callback gets unused gas by weight, so more is safer. `execute` with Withdraw: the frontend default is 100 Tgas.

## 5. `simple_withdraw`

```rust
// BL:actions.rs:833-863
#[payable]
pub fn simple_withdraw(&mut self, token_id: AccountId, amount_with_inner_decimal: U128,
                       recipient_id: Option<AccountId>) -> Promise
```
```json
{"token_id":"wrap.near","amount_with_inner_decimal":"1000000000000000000000000","recipient_id":null}
```
- 1 yocto. Takes from *supplied* first. Any gap comes from **DecreaseCollateral**, fetching prices itself when needed (`internal_decrease_collateral_for_gap`, `:938-979`, asserting `enable_pyth_oracle`). Then it withdraws the exact amount.
- **Returns its Promise.** The final value is the `bool` from `after_ft_transfer` (doc comment `:830-832`). Unlike `execute_with_pyth`, the vault **can** `.then()` on the actual result. `false` = the ft_transfer failed and the amount was re-credited to supplied.
- `recipient_id` may be any account. **The vault must pass `None` (= itself)** and never take this value from the agent.
- Panics "No collateral available" if a gap exists with no collateral entry, and "Withdraw amount can't be 0" if ft amount rounds to 0 (`:931`).

## 6. Answers to vault-spec §12

1. **Supply-as-collateral msg:** `"\"OnlyIncreaseCollateral\""` (§2b). Or `{"Execute":{"actions":[{"IncreaseCollateral":{"token_id":T,"max_amount":"<ft_amount*10^extra>"}}]}}`. **Repay msg:** `"\"OnlyRepay\""` (§2e). Both are present in the deployed 0.16.2 wasm.
2. **`get_account_all_positions` shape:** returns **both** `balance` (inner-decimal amount, interest accrued to now) and `shares` per asset, plus `apr`. Details in `views-and-health.md` §1. Use `balance` for HF. It already uses Burrow's rounding (collateral rounded down, debt rounded up: `BL:account_view.rs:299-303`).
7. **Oracle cross-contract:** `get_price_no_older_than` is a plain non-payable function. Burrow itself calls it cross-contract (`BL:pyth.rs:125-128`), and it also works as an RPC view (`LIVE`). Any account can call it.

## 7. Deployed (0.16.2) vs repo (0.15.7)

Checked by downloading the wasm (`view_code`, hash `6Nek1MZ8…`, 1,059,499 bytes) and listing its function exports and strings:
- Present: `execute`, `execute_with_pyth`, `simple_withdraw`, `ft_on_transfer`, `storage_deposit`/`storage_balance_of`/`storage_withdraw`/`storage_unregister`, `get_account`, `get_account_all_positions`, `list_accounts_all_positions`, `get_asset(s)`, `get_assets_paged(_detailed)`, `get_config`, `get_all_token_pyth_infos`, `get_token_pyth_info`, `get_last_prices`, `get_version`, `callback_execute_with_pyth`, `callback_simple_withdraw_with_pyth`. Variant strings `OnlyRepay`, `OnlyIncreaseCollateral`, `ExecuteWithPyth`, `IncreaseCollateral`, `DecreaseCollateral`, `max_amount`, `amount_with_inner_decimal` are embedded.
- New, not in the repo: `get_enabled_margin_actions` (live `["Withdraw"]`), `batch_enable/disable_margin_actions`, `pause_contract`, `update_contract_mode` (`get_config.contract_mode` = `"Running"`; other modes `RunningWithoutPublicLiquidation`, `Maintenance`), `append/remove/get_maintenance_mode_whitelist`, `append/remove/get_delist_token_list` (live `[]`), `get_storage_balance_of_detail`, `update_liquidation_benefits_rates`, `update_pause_operator_id`.
- Behavior in 0.16.x that we can't see in source [VERIFY]: exactly which calls Maintenance mode blocks ("Account is not allowed in maintenance mode"), and whether regular (non-margin) liquidations now pay a protocol cut (`liq_benefit_*_rate` in `get_margin_config` = 5000/5000).
- Vault handling: before each agent action, read `get_config` and treat `contract_mode != "Running"` as a reason to stop. Treat `get_delist_token_list` containing a held token as a reason to stop borrowing.

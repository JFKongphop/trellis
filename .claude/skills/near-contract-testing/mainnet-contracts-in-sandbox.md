# Mainnet contracts in the sandbox ("spooning")

Goal: run the vault against the **real** wasm of `wrap.near`, `v2.ref-finance.near` and `contract.main.burrow.near`, deployed at their **real account ids**, plus mocks for USDC and `aggregate-oracle.near`. The production build of the vault, with its hardcoded ids, is then the one under test.

Everything in sections 1–5 was run end to end on 2026-10-22 (near-workspaces 0.23.0, mainnet wasm at the latest block). Ref was v1.9.20, Burrow v0.16.2. Section 6 (mock oracle + borrow) is compile- and unit-tested but **not yet run in the sandbox** [VERIFY].

## How `import_contract` works (0.23 source)

```rust
worker.import_contract(&id, &source_worker)     // source = mainnet()/testnet()/…_archival()
    .initial_balance(NearToken::from_near(100)) // else copies the mainnet balance
    .block_height(h) / .block_hash(hash)        // needs an ARCHIVAL source if older than ~5 epochs
    .with_data()                                // also copy state; RPC view_state caps at ~50 KB
    .dest_account_id(&other_id)                 // import under a different id
    .transact().await?                          // -> Contract, signer = key from DEV_ACCOUNT_SEED
```

What it does:
- Copies the `AccountView`, including the mainnet **storage_usage**.
- Adds a full-access key.
- Copies the code. Global-contract accounts keep their `contract_state`.
- Copies the state only with `with_data()`.

Limits and gotchas:
- **`with_data()` is useless for Ref, Burrow and wrap.** Their state is far above the RPC limit. Import code only, then call the init method yourself.
- **storage_usage gotcha.** wrap.near reports about 157 MB of storage, so `initial_balance(100 NEAR)` gives `LackBalanceForState` on the first call. Either keep the mainnet balance (omit `initial_balance`), or patch `storage_usage` down as `spoon()` does below.
- **Patching an account replaces the whole record.** Build the patch from the current account (`AccountDetailsPatch::from(cur)`). A bare `AccountDetailsPatch::default()` clears `contract_state`, and the next call fails with `CodeDoesNotExist`.
- `worker.patch_state(id, key, value)` / `.patch(id).state(k, v)` write raw borsh state. That is fine for small contracts you control. Don't hand-craft Ref or Burrow state.
- Point the source at FastNEAR: `near_workspaces::mainnet().rpc_addr("https://rpc.mainnet.fastnear.com")`. The built-in default is `rpc.mainnet.near.org`; archival is `archival-rpc.mainnet.near.org`. [VERIFY FastNEAR archival URL if you pin heights]
- Prefer the **latest** block over a pinned height. That is what Burrow and Ref run today, and it needs no archival node. Pin with `.block_height()` only when you need reproducibility.

## Shared helpers (verified)

```rust
use near_workspaces::network::{Mainnet, Sandbox};
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{AccessKey, Account, AccountDetailsPatch, AccountId, Contract, Worker};
use serde_json::{json, Value};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // native USDC on NEAR

/// Import mainnet code (no state) under the same id, with a sane storage_usage.
async fn spoon(worker: &Worker<Sandbox>, mainnet: &Worker<Mainnet>, id: &str) -> anyhow::Result<Contract> {
    let id: AccountId = id.parse()?;
    let c = worker.import_contract(&id, mainnet)
        .initial_balance(NearToken::from_near(100)).transact().await?;
    let code_len = worker.view_code(&id).await?.len() as u64;
    worker.patch(&id)
        .account_from_current(move |cur| AccountDetailsPatch::from(cur).storage_usage(code_len + 10_000))
        .transact().await?;
    Ok(c)
}

/// Put arbitrary wasm at ANY account id (mainnet names, implicit 64-hex ids, ...).
async fn deploy_at(worker: &Worker<Sandbox>, id: &str, wasm: &[u8]) -> anyhow::Result<Contract> {
    let id: AccountId = id.parse()?;
    let sk = SecretKey::from_random(KeyType::ED25519);
    worker.patch(&id)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(100)))
        .access_key(sk.public_key(), AccessKey::full_access())
        .code(wasm)
        .transact().await?;
    Ok(Contract::from_secret_key(id, sk, worker))
}

/// NEP-145 registration of `who` on `token`, paid by `payer`.
async fn ft_register(payer: &Account, token: &AccountId, who: &AccountId) -> anyhow::Result<()> {
    payer.call(token, "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(125)).transact().await?.into_result()?;
    Ok(())
}
```

Setup used below:

```rust
let worker = near_workspaces::sandbox().await?;
let mainnet: Worker<Mainnet> = near_workspaces::mainnet().rpc_addr("https://rpc.mainnet.fastnear.com").await?;
let root = worker.root_account()?;                        // test.near
let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(300))
    .transact().await?.into_result()?;
```

## 1. wrap.near

```rust
let wrap = spoon(&worker, &mainnet, "wrap.near").await?;
root.call(wrap.id(), "new").transact().await?.into_result()?;             // init takes no args
for a in [&root, &alice] {                                                    // register + wrap 150 NEAR each
    ft_register(a, wrap.id(), a.id()).await?;
    a.call(wrap.id(), "near_deposit").deposit(NearToken::from_near(150)).transact().await?.into_result()?;
}
```

## 2. Mock USDC at the real USDC id (6 decimals)

Use any NEP-141 wasm. The verified run used `examples/res/fungible_token.wasm` from near-workspaces-rs, which is near-sdk's `examples/fungible-token`. Build your own with `cargo near build` in `near-sdk-rs/examples/fungible-token/ft`.

```rust
let usdc = deploy_at(&worker, USDC, &ft_wasm).await?;
usdc.call("new").args_json(json!({
    "owner_id": root.id(),
    "total_supply": "1000000000000",                                   // 1,000,000 USDC
    "metadata": { "spec": "ft-1.0.0", "name": "Mock USDC", "symbol": "USDC", "decimals": 6 }
})).transact().await?.into_result()?;
// fund users with: root.call(usdc.id(), "ft_transfer") {receiver_id, amount} + 1 yocto (after ft_register)
```

To test fake tokens, deploy the same FT wasm at `usdc-fake.test.near` with symbol "USDC". The vault must reject it because of the token id, not the symbol.

## 3. Ref v2 (`v2.ref-finance.near`): init, register, pool, liquidity, swap

Method names come from the ref-exchange source (v1.9.18 mirror) and were checked against mainnet v1.9.20 wasm.

```rust
let refx = spoon(&worker, &mainnet, "v2.ref-finance.near").await?;
// v1.9.x init: new(owner_id, boost_farm_id, burrowland_id, exchange_fee, referral_fee)
root.call(refx.id(), "new").args_json(json!({
    "owner_id": root.id(), "boost_farm_id": "boostfarm.ref-labs.near",
    "burrowland_id": "contract.main.burrow.near", "exchange_fee": 2000, "referral_fee": 0
})).transact().await?.into_result()?;

for a in [&root, &alice] {                                       // Ref account storage (vault too!)
    a.call(refx.id(), "storage_deposit").args_json(json!({}))
        .deposit(NearToken::from_millinear(100)).transact().await?.into_result()?;
}
// owner/guardian only, 1 yocto
root.call(refx.id(), "extend_whitelisted_tokens")
    .args_json(json!({ "tokens": [wrap.id(), usdc.id()] })).deposit(ONE_YOCTO).transact().await?.into_result()?;
// permissionless; fee in bps; deposit covers pool storage; returns pool id
let pool_id: u64 = root.call(refx.id(), "add_simple_pool")
    .args_json(json!({ "tokens": [wrap.id(), usdc.id()], "fee": 30 }))
    .deposit(NearToken::from_millinear(100)).transact().await?.json()?;
ft_register(&root, wrap.id(), refx.id()).await?;
ft_register(&root, usdc.id(), refx.id()).await?;

// deposit liquidity (msg "" = plain deposit into the sender's Ref balance)
for (tok, amt) in [(wrap.id(), "100000000000000000000000000"), (usdc.id(), "500000000")] {
    root.call(tok, "ft_transfer_call")
        .args_json(json!({ "receiver_id": refx.id(), "amount": amt, "msg": "" }))
        .deposit(ONE_YOCTO).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
}
// amounts in pool token order; needs a deposit > 0 (storage for shares)
root.call(refx.id(), "add_liquidity")
    .args_json(json!({ "pool_id": pool_id, "amounts": ["100000000000000000000000000", "500000000"] }))
    .deposit(NearToken::from_millinear(100)).transact().await?.into_result()?;   // 5 USDC per NEAR
```

The swap flow the vault uses (spec §6.3): deposit, then `swap` (which returns the amount out), then `withdraw`.

```rust
ft_register(&root, usdc.id(), alice.id()).await?;               // so Ref can send USDC to alice
alice.call(wrap.id(), "ft_transfer_call")
    .args_json(json!({ "receiver_id": refx.id(), "amount": "1000000000000000000000000", "msg": "" }))
    .deposit(ONE_YOCTO).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
let out: String = alice.call(refx.id(), "swap").args_json(json!({ "actions": [{
        "pool_id": pool_id, "token_in": wrap.id(), "token_out": usdc.id(),
        "amount_in": "1000000000000000000000000", "min_amount_out": "1" }] }))
    .deposit(ONE_YOCTO).gas(Gas::from_tgas(100)).transact().await?.json()?;   // measured "4935790"
alice.call(refx.id(), "withdraw").args_json(json!({ "token_id": usdc.id(), "amount": out }))
    .deposit(ONE_YOCTO).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
```

Useful views and facts:
- `get_pool {pool_id}` returns `{token_account_ids, amounts, total_fee, pool_kind, shares_total_supply, amp}`.
- `get_return {pool_id, token_in, amount_in, token_out}`.
- `get_deposits {account_id}` and `get_deposit {account_id, token_id}`.
- `metadata`.
- `swap` with `min_amount_out` too high fails with `E68: slippage error`. This is the vault's slippage test: move the pool price with a big swap from root, then have the agent swap.
- A deposit of a token that is neither whitelisted nor registered (`register_tokens`, 1 yocto) panics with `E12: token not whitelisted`.
- Without an attached deposit, `swap` requires all tokens to be whitelisted or registered.

## 4. Burrow (`contract.main.burrow.near`): init + assets (verified)

```rust
let burrow = spoon(&worker, &mainnet, "contract.main.burrow.near").await?;
let burrow_id: AccountId = "contract.main.burrow.near".parse()?;
// Copy the LIVE config shape (0.16.2 has fields the public repo's 0.15.7 Config lacks:
// contract_mode, pause_operator_id). Only swap the owner.
let mut config: Value = mainnet.view(&burrow_id, "get_config").await?.json()?;
config["owner_id"] = json!(root.id());           // pyth_oracle_account_id stays "aggregate-oracle.near"
root.call(burrow.id(), "new").args_json(json!({ "config": config })).max_gas().transact().await?.into_result()?;

for tok in [wrap.id(), usdc.id()] {
    let asset: Value = mainnet.view(&burrow_id, "get_asset").args_json(json!({ "token_id": tok })).await?.json()?;
    let mut cfg = asset["config"].clone();
    cfg["beneficiaries"] = json!({});             // mainnet fee beneficiary doesn't exist here
    root.call(burrow.id(), "add_asset").args_json(json!({ "token_id": tok, "asset_config": cfg }))
        .deposit(ONE_YOCTO).max_gas().transact().await?.into_result()?;
    let pyth: Value = mainnet.view(&burrow_id, "get_token_pyth_info").args_json(json!({ "token_id": tok })).await?.json()?;
    // wrap.near: {"decimals":24,"fraction_digits":4,"price_identifier":"c415de8d…6750",...}
    // USDC:      {"decimals":6, "fraction_digits":4,"price_identifier":"eaa020c6…c94a",...}
    root.call(burrow.id(), "add_token_pyth_info").args_json(json!({ "token_id": tok, "token_pyth_info": pyth }))
        .deposit(ONE_YOCTO).transact().await?.into_result()?;
    ft_register(&root, tok, burrow.id()).await?;  // Burrow must hold storage on each FT
}
// user (or vault) storage on Burrow: min 0.1 NEAR (10_000 bytes)
alice.call(burrow.id(), "storage_deposit").args_json(json!({}))
    .deposit(NearToken::from_millinear(250)).transact().await?.into_result()?;
```

Copying the live configs keeps the sandbox at mainnet values: wNEAR `volatility_ratio` 7500, USDC `extra_decimals` 12, and so on. That is what the vault's HF math must match.

## 5. Burrow supply as collateral (verified, no prices needed)

```rust
alice.call(wrap.id(), "ft_transfer_call").args_json(json!({
    "receiver_id": burrow.id(), "amount": "10000000000000000000000000",
    "msg": json!({"Execute":{"actions":[{"IncreaseCollateral":{"token_id": wrap.id()}}]}}).to_string()
})).deposit(ONE_YOCTO).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
let pos: Value = burrow.view("get_account_all_positions").args_json(json!({ "account_id": alice.id() })).await?.json()?;
// {"positions":{"REGULAR":{"collateral":[{"token_id":"wrap.near","balance":"1000…","shares":"1000…","apr":"0.0"}],"borrowed":[]}},"supplied":[],...}
```

Burrow logs NEP-297 events with `"standard":"burrow"`: `deposit`, `increase_collateral`, `fee_detail`. Other `ft_on_transfer` msgs (enum `TokenReceiverMsg`) are:
- `""`: supply.
- `{"Execute":{actions}}`.
- `{"ExecuteWithPyth":{actions}}`.
- `"OnlyIncreaseCollateral"`.
- `"OnlyRepay"`.
- `"DepositToReserve"`.

Exact vault message choices are in `rhea-burrow-lending`.

**Without an oracle** (measured): `execute_with_pyth [Borrow, Withdraw]` returns `is_success() == true`, but the `aggregate-oracle.near` receipts and Burrow's callback fail (3 receipt failures). This is a good "oracle down" test case.

## 6. Mock Pyth oracle at `aggregate-oracle.near` (needed for borrow / withdraw-with-debt)

Burrow's `execute_with_pyth` calls `get_price_no_older_than(price_id, age = pyth_price_valid_duration_sec)` on `pyth_oracle_account_id` for each involved token, using a hex string id. It expects `Option<{price: I64-string, conf: U64-string, expo: i32, publish_time: i64 secs}>`. It panics if the price is `None` or if `publish_time + 60 s < block_timestamp`. The burrowland repo ships `contracts/mock-pyth` (near-sdk 4.1, ignores `age`). `contracts/test-oracle` is for the old `priceoracle.near` `oracle_call` flow, so don't use it.

A near-sdk 5.29 mock that also enforces `age`, so stale-price tests work. It is unit-tested, and the JSON matches the live mainnet response.

```rust
use near_sdk::json_types::{I64, U64};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PythPrice { pub price: I64, pub conf: U64, pub expo: i32, pub publish_time: i64 }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOracle { owner: AccountId, prices: IterableMap<String, PythPrice> }

#[near]
impl MockOracle {
    #[init]
    pub fn new(owner: AccountId) -> Self { Self { owner, prices: IterableMap::new(b"p") } }
    pub fn set_price(&mut self, price_identifier: String, pyth_price: PythPrice) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
        self.prices.insert(price_identifier, pyth_price);
    }
    pub fn get_price(&self, price_identifier: String) -> Option<PythPrice> { self.prices.get(&price_identifier).cloned() }
    pub fn get_price_no_older_than(&self, price_id: String, age: u64) -> Option<PythPrice> {
        let now = (env::block_timestamp() / 1_000_000_000) as i64;
        self.prices.get(&price_id).filter(|p| now.saturating_sub(p.publish_time) <= age as i64).cloned()
    }
}
```

Sandbox use: **verified 2026-10-22** with real Burrow v0.16.2 wasm. Full runnable test: `examples/borrow_flow.rs` (mock oracle source: `examples/mock_oracle_lib.rs`). Build the mock with:
`RUSTFLAGS='--cfg near -C link-arg=-s -C target-cpu=mvp' cargo build --target wasm32-unknown-unknown --release` (or `cargo near build`).

Verified results: fresh-price borrow works (~20 Tgas burnt total); stale price → callback panics "Missing <id> price", no debt; borrow-only beyond HF 1 → panics `compute_max_discount == 0`; `OnlyRepay` overpay → debt 0, remainder in `supplied`; `execute` with no debt withdraws everything without prices.

Gotchas found:
- **Compare debt `shares`, not `balance`**: balance grows with interest every block, even in the sandbox.
- **`Borrow X` + `Withdraw {amount: X}` can fail at random** ("Not enough asset balance"): supplied is sometimes credited 1 inner unit short (2e18 → 1999999999999999999). Use `max_amount` or omit the amount.
- Every failed borrow still has top-level `is_success() == true`. Check `receipt_failures()`.

```rust
let oracle = deploy_at(&worker, "aggregate-oracle.near", &mock_oracle_wasm).await?;
oracle.call("new").args_json(json!({ "owner": root.id() })).transact().await?.into_result()?;
let now = (worker.view_block().await?.timestamp() / 1_000_000_000) as i64;   // sandbox time = wall clock
for (id, price) in [("c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750", "500000000"), // NEAR $5.00
                    ("eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", "100000000")] { // USDC $1.00
    root.call(oracle.id(), "set_price").args_json(json!({ "price_identifier": id,
        "pyth_price": { "price": price, "conf": "50000", "expo": -8, "publish_time": now } }))
        .transact().await?.into_result()?;
}
// Borrow 1 USDC (Burrow inner decimals: 6 + extra 12 = 18)
let res = alice.call(burrow.id(), "execute_with_pyth").args_json(json!({ "actions": [
    {"Borrow":   {"token_id": USDC, "amount": "1000000000000000000"}},
    {"Withdraw": {"token_id": USDC, "max_amount": "1000000000000000000"}} ] }))   // max_amount, NOT amount (rounding)
    .deposit(ONE_YOCTO).max_gas().transact().await?;
assert!(res.receipt_failures().is_empty(), "{:?}", res.receipt_failures());
```

Notes:
- Borrowing needs USDC liquidity in Burrow first: root supplies USDC with `ft_transfer_call` and msg `""`.
- Refresh `publish_time` after every `fast_forward`.
- The vault's own oracle reads go to the same mock, so the vault and Burrow see identical prices.
- Stale price test: set `publish_time = now - 120`.
- Wide confidence test: set `conf` to 5% of the price.
- Price crash test (HF breach / liquidation): lower the NEAR price.

## If full Burrow is too heavy: mock lending fallback

If importing Burrow becomes a time sink (new init fields, asset limits, oracle quirks), write a ~150-line `mock-burrow` that exposes the vault-facing surface only:
- `storage_deposit`.
- `ft_on_transfer` (msg `""`/`Execute{IncreaseCollateral}`/`"OnlyRepay"`).
- `execute` / `execute_with_pyth` (Borrow/Withdraw/DecreaseCollateral/Repay), with a configurable "fail next call" switch.
- `get_account_all_positions` in the exact JSON shape above.

Deploy it at `contract.main.burrow.near` with `deploy_at`. Then test the vault's state machine (reserve, submit, sync, settle) quickly, and keep **one** test that uses real Burrow wasm for supply, which is verified here. This choice is ours, not from upstream docs. Use it only if section 6 fails in practice.

## Sources (2026-10-22)

- near-workspaces 0.23.0 `src/rpc/patch.rs` (ImportContractTransaction, PatchTransaction), `tests/patch_state.rs`, `examples/src/{ref_finance,spooning}.rs`: https://github.com/near/near-workspaces-rs/tree/near-workspaces-v0.23.0
- burrowland: `contracts/mock-pyth/src/lib.rs`, `contracts/contract/src/{pyth.rs,config.rs,fungible_token.rs,actions.rs,storage.rs}`, `tests/workspace_env/{setup.rs,contract_burrowland.rs}`: https://github.com/ref-finance/burrowland
- ref-exchange (official repo 404; unofficial mirror v1.9.18): `src/{lib.rs,account_deposit.rs,owner.rs,token_receiver.rs,action.rs}`
- Live mainnet views: Burrow `get_version` = 0.16.2, `get_config`, `get_asset`, `get_token_pyth_info`; Ref `metadata` = 1.9.20; `aggregate-oracle.near get_price_no_older_than`.
- Verified locally: `verify-sandbox/tests/stack.rs` (sections 1–5) passed. Mock oracle unit test passed.

//! Sandbox borrow flow against REAL mainnet Burrow (v0.16.2) wasm + a mock Pyth oracle at aggregate-oracle.near.
use near_workspaces::network::{Mainnet, Sandbox};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{AccessKey, Account, AccountDetailsPatch, AccountId, Contract, Worker};
use serde_json::{json, Value};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NEAR_PID: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const USDC_PID: &str = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
const ORACLE_WASM: &[u8] = include_bytes!(
    "../../verify-oracle/target/wasm32-unknown-unknown/release/mock_pyth_oracle.wasm"
);

async fn spoon(worker: &Worker<Sandbox>, mainnet: &Worker<Mainnet>, id: &str) -> anyhow::Result<Contract> {
    let id: AccountId = id.parse()?;
    let c = worker.import_contract(&id, mainnet).initial_balance(NearToken::from_near(100)).transact().await?;
    let code_len = worker.view_code(&id).await?.len() as u64;
    worker.patch(&id)
        .account_from_current(move |cur| AccountDetailsPatch::from(cur).storage_usage(code_len + 10_000))
        .transact().await?;
    Ok(c)
}

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

async fn ft_register(payer: &Account, token: &AccountId, who: &AccountId) -> anyhow::Result<()> {
    payer.call(token, "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(125)).transact().await?.into_result()?;
    Ok(())
}

/// Set NEAR and USDC prices with publish_time = now + `offset_sec`.
async fn set_prices(worker: &Worker<Sandbox>, root: &Account, oracle: &AccountId, near_usd_e8: &str, offset_sec: i64) -> anyhow::Result<()> {
    let now = (worker.view_block().await?.timestamp() / 1_000_000_000) as i64 + offset_sec;
    for (id, price) in [(NEAR_PID, near_usd_e8), (USDC_PID, "100000000")] {
        root.call(oracle, "set_price").args_json(json!({ "price_identifier": id,
            "pyth_price": { "price": price, "conf": "50000", "expo": -8, "publish_time": now } }))
            .transact().await?.into_result()?;
    }
    Ok(())
}

fn report(label: &str, res: &ExecutionFinalResult) {
    println!("--- {label}: top-level success={} failures={}", res.is_success(), res.receipt_failures().len());
    for o in res.receipt_outcomes() {
        let fail = if o.is_failure() { " FAILED" } else { "" };
        println!("    {:<32} {:>6.1} Tgas{}", o.executor_id.as_str(), o.gas_burnt.as_gas() as f64 / 1e12, fail);
        for l in &o.logs { if l.len() < 300 { println!("        log: {l}"); } }
    }
    for f in res.receipt_failures() { println!("    failure: {:?}", f.clone().into_result().err()); }
}

async fn positions(burrow: &Contract, who: &AccountId) -> anyhow::Result<Value> {
    Ok(burrow.view("get_account_all_positions").args_json(json!({ "account_id": who })).await?.json()?)
}

async fn usdc_balance(worker: &Worker<Sandbox>, who: &AccountId) -> anyhow::Result<u128> {
    let usdc: AccountId = USDC.parse()?;
    let v: String = worker.view(&usdc, "ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
    Ok(v.parse()?)
}

fn debt(pos: &Value) -> String { debt_field(pos, "balance") }
/// Shares change only on real borrow/repay; balance also grows with interest every block.
fn debt_shares(pos: &Value) -> String { debt_field(pos, "shares") }
fn debt_field(pos: &Value, f: &str) -> String {
    pos["positions"]["REGULAR"]["borrowed"].as_array()
        .and_then(|a| a.iter().find(|x| x["token_id"] == USDC)).and_then(|x| x[f].as_str()).map(String::from)
        .unwrap_or_else(|| "0".into())
}

#[tokio::test]
async fn borrow_flow() -> anyhow::Result<()> {
    let ft_wasm = include_bytes!("../res/fungible_token.wasm").to_vec();
    let worker = near_workspaces::sandbox().await?;
    let mainnet: Worker<Mainnet> = near_workspaces::mainnet().rpc_addr("https://rpc.mainnet.fastnear.com").await?;
    let root = worker.root_account()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(300)).transact().await?.into_result()?;

    // wrap.near (real code)
    let wrap = spoon(&worker, &mainnet, "wrap.near").await?;
    root.call(wrap.id(), "new").transact().await?.into_result()?;
    ft_register(&root, wrap.id(), alice.id()).await?;
    alice.call(wrap.id(), "near_deposit").deposit(NearToken::from_near(150)).transact().await?.into_result()?;

    // mock USDC at the real id; give alice 100 USDC
    let usdc = deploy_at(&worker, USDC, &ft_wasm).await?;
    usdc.call("new").args_json(json!({ "owner_id": root.id(), "total_supply": "1000000000000",
        "metadata": { "spec": "ft-1.0.0", "name": "Mock USDC", "symbol": "USDC", "decimals": 6 } }))
        .transact().await?.into_result()?;
    ft_register(&root, usdc.id(), alice.id()).await?;
    root.call(usdc.id(), "ft_transfer").args_json(json!({ "receiver_id": alice.id(), "amount": "100000000" }))
        .deposit(ONE_YOCTO).transact().await?.into_result()?;

    // mock oracle at aggregate-oracle.near
    let oracle = deploy_at(&worker, "aggregate-oracle.near", ORACLE_WASM).await?;
    oracle.call("new").args_json(json!({ "owner": root.id() })).transact().await?.into_result()?;

    // Burrow (real mainnet code) with live config + assets
    let burrow = spoon(&worker, &mainnet, "contract.main.burrow.near").await?;
    let burrow_id: AccountId = "contract.main.burrow.near".parse()?;
    let mut config: Value = mainnet.view(&burrow_id, "get_config").await?.json()?;
    config["owner_id"] = json!(root.id());
    println!("pyth oracle = {}, valid_duration = {}", config["pyth_oracle_account_id"], config["pyth_price_valid_duration_sec"]);
    root.call(burrow.id(), "new").args_json(json!({ "config": config })).max_gas().transact().await?.into_result()?;
    for tok in [wrap.id(), usdc.id()] {
        let asset: Value = mainnet.view(&burrow_id, "get_asset").args_json(json!({ "token_id": tok })).await?.json()?;
        let mut cfg = asset["config"].clone();
        cfg["beneficiaries"] = json!({});
        root.call(burrow.id(), "add_asset").args_json(json!({ "token_id": tok, "asset_config": cfg }))
            .deposit(ONE_YOCTO).max_gas().transact().await?.into_result()?;
        let pyth: Value = mainnet.view(&burrow_id, "get_token_pyth_info").args_json(json!({ "token_id": tok })).await?.json()?;
        root.call(burrow.id(), "add_token_pyth_info").args_json(json!({ "token_id": tok, "token_pyth_info": pyth }))
            .deposit(ONE_YOCTO).transact().await?.into_result()?;
        ft_register(&root, tok, burrow.id()).await?;
    }
    for a in [&root, &alice] {
        a.call(burrow.id(), "storage_deposit").args_json(json!({}))
            .deposit(NearToken::from_millinear(250)).transact().await?.into_result()?;
    }

    // root supplies 10,000 USDC liquidity (msg "" = plain supply)
    root.call(usdc.id(), "ft_transfer_call").args_json(json!({ "receiver_id": burrow.id(), "amount": "10000000000", "msg": "" }))
        .deposit(ONE_YOCTO).gas(Gas::from_tgas(150)).transact().await?.into_result()?;

    // alice supplies 10 wNEAR as collateral with the msg the vault will use
    let r = alice.call(wrap.id(), "ft_transfer_call").args_json(json!({
        "receiver_id": burrow.id(), "amount": "10000000000000000000000000", "msg": "\"OnlyIncreaseCollateral\"" }))
        .deposit(ONE_YOCTO).gas(Gas::from_tgas(150)).transact().await?;
    report("supply 10 wNEAR (OnlyIncreaseCollateral)", &r);
    assert!(r.receipt_failures().is_empty());
    println!("positions after supply: {}", positions(&burrow, alice.id()).await?);

    let borrow = |amt: &'static str| {
        alice.call(burrow.id(), "execute_with_pyth").args_json(json!({ "actions": [
            {"Borrow": {"token_id": USDC, "amount": amt}},
            {"Withdraw": {"token_id": USDC, "amount": amt}} ] }))
            .deposit(ONE_YOCTO).gas(Gas::from_tgas(300))
    };

    // A) normal borrow: 5 USDC at NEAR = $5.00 (collateral $50 → HF ≈ 7)
    set_prices(&worker, &root, oracle.id(), "500000000", 0).await?;
    let bal0 = usdc_balance(&worker, alice.id()).await?;
    let r = borrow("5000000000000000000").transact().await?;
    report("A) borrow 5 USDC, fresh price", &r);
    let bal1 = usdc_balance(&worker, alice.id()).await?;
    let p = positions(&burrow, alice.id()).await?;
    println!("A) usdc received = {} (raw), debt = {}", bal1 - bal0, debt(&p));
    assert!(r.receipt_failures().is_empty(), "normal borrow failed");
    assert!(bal1 - bal0 >= 4_999_999);

    // B) stale price (publish_time 120 s ago) → callback should fail, no new debt
    set_prices(&worker, &root, oracle.id(), "500000000", -120).await?;
    let debt_before = debt_shares(&positions(&burrow, alice.id()).await?);
    let r = borrow("1000000000000000000").transact().await?;
    report("B) borrow 1 USDC, stale price", &r);
    let debt_after = debt_shares(&positions(&burrow, alice.id()).await?);
    println!("B) top-level is_success={} (expect true even though it failed), debt shares {} -> {}", r.is_success(), debt_before, debt_after);
    assert!(!r.receipt_failures().is_empty(), "stale price borrow should fail inside");
    assert_eq!(debt_before, debt_after, "stale price must not add debt");

    // C) borrow beyond HF 1: collateral $50 × 0.75 = $37.5 adjusted; 40 USDC debt / 0.95 ≈ $42 → must fail
    set_prices(&worker, &root, oracle.id(), "500000000", 0).await?;
    let debt_before = debt_shares(&positions(&burrow, alice.id()).await?);
    // C1: Borrow ONLY (no Withdraw) — isolates Burrow's own HF check
    let r = alice.call(burrow.id(), "execute_with_pyth").args_json(json!({ "actions": [
            {"Borrow": {"token_id": USDC, "amount": "40000000000000000000"}} ] }))
            .deposit(ONE_YOCTO).gas(Gas::from_tgas(300)).transact().await?;
    report("C1) borrow-only 40 USDC, HF would be < 1", &r);
    assert!(!r.receipt_failures().is_empty(), "HF-breaching borrow-only should fail");
    // C2: safe borrow 2 USDC + Withdraw with NO amount (withdraw all supplied of that token)
    set_prices(&worker, &root, oracle.id(), "500000000", 0).await?;
    let r2 = alice.call(burrow.id(), "execute_with_pyth").args_json(json!({ "actions": [
            {"Borrow": {"token_id": USDC, "amount": "2000000000000000000"}},
            {"Withdraw": {"token_id": USDC}} ] }))
            .deposit(ONE_YOCTO).gas(Gas::from_tgas(300)).transact().await?;
    report("C2) borrow 2 USDC + Withdraw(no amount)", &r2);
    assert!(r2.receipt_failures().is_empty());
    // C3: 30 USDC borrow + exact Withdraw (HF ok: 37.5 / (37/0.95)≈0.96?) — print outcome only
    set_prices(&worker, &root, oracle.id(), "500000000", 0).await?;
    let r = borrow("40000000000000000000").transact().await?;
    report("C3) borrow 40 USDC + exact Withdraw", &r);
    let debt_after = debt_shares(&positions(&burrow, alice.id()).await?);
    assert!(!r.receipt_failures().is_empty(), "HF-breaching borrow should fail");
    println!("C) debt shares {debt_before} -> {debt_after} (C2 added 2 USDC)");

    // D) repay with overpay (6 USDC vs ~5 debt) → debt 0, remainder lands as plain "supplied"
    let r = alice.call(usdc.id(), "ft_transfer_call").args_json(json!({
        "receiver_id": burrow.id(), "amount": "8000000", "msg": "\"OnlyRepay\"" }))
        .deposit(ONE_YOCTO).gas(Gas::from_tgas(150)).transact().await?;
    report("D) repay 6 USDC (OnlyRepay)", &r);
    let p = positions(&burrow, alice.id()).await?;
    println!("D) positions after repay: {p}");
    assert!(r.receipt_failures().is_empty());
    assert_eq!(debt(&p), "0");

    // E) debt is 0 → withdraw leftover USDC + all collateral with plain execute (no prices)
    let r = alice.call(burrow.id(), "execute").args_json(json!({ "actions": [
        {"Withdraw": {"token_id": USDC}},
        {"DecreaseCollateral": {"token_id": wrap.id()}},
        {"Withdraw": {"token_id": wrap.id()}} ] }))
        .deposit(ONE_YOCTO).gas(Gas::from_tgas(150)).transact().await?;
    report("E) withdraw everything (execute, no prices)", &r);
    let p = positions(&burrow, alice.id()).await?;
    println!("E) positions after withdraw: {p}");
    assert!(r.receipt_failures().is_empty());

    println!("ALL BORROW CHECKS PASSED");
    Ok(())
}

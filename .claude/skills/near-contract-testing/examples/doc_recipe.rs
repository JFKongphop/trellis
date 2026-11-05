use near_workspaces::network::{Mainnet, Sandbox};
use near_workspaces::result::ExecutionFinalResult;
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

#[tokio::test]
async fn doc_recipe() -> anyhow::Result<()> {
    let ft_wasm = include_bytes!("../res/fungible_token.wasm").to_vec();
let worker = near_workspaces::sandbox().await?;
let mainnet: Worker<Mainnet> = near_workspaces::mainnet().rpc_addr("https://rpc.mainnet.fastnear.com").await?;
let root = worker.root_account()?;                        // test.near
let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(300))
    .transact().await?.into_result()?;

let wrap = spoon(&worker, &mainnet, "wrap.near").await?;
root.call(wrap.id(), "new").transact().await?.into_result()?;             // init takes no args
for a in [&root, &alice] {                                                    // register + wrap 150 NEAR each
    ft_register(a, wrap.id(), a.id()).await?;
    a.call(wrap.id(), "near_deposit").deposit(NearToken::from_near(150)).transact().await?.into_result()?;
}

let usdc = deploy_at(&worker, USDC, &ft_wasm).await?;
usdc.call("new").args_json(json!({
    "owner_id": root.id(),
    "total_supply": "1000000000000",                                   // 1,000,000 USDC
    "metadata": { "spec": "ft-1.0.0", "name": "Mock USDC", "symbol": "USDC", "decimals": 6 }
})).transact().await?.into_result()?;
// fund users with: root.call(usdc.id(), "ft_transfer") {receiver_id, amount} + 1 yocto (after ft_register)

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

alice.call(wrap.id(), "ft_transfer_call").args_json(json!({
    "receiver_id": burrow.id(), "amount": "10000000000000000000000000",
    "msg": json!({"Execute":{"actions":[{"IncreaseCollateral":{"token_id": wrap.id()}}]}}).to_string()
})).deposit(ONE_YOCTO).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
let pos: Value = burrow.view("get_account_all_positions").args_json(json!({ "account_id": alice.id() })).await?.json()?;
// {"positions":{"REGULAR":{"collateral":[{"token_id":"wrap.near","balance":"1000…","shares":"1000…","apr":"0.0"}],"borrowed":[]}},"supplied":[],...}

    println!("OK out={out} pos={pos}");
    Ok(())
}

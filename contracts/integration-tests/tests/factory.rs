//! Factory: creates an initialized vault owned by the caller, with no access keys; refunds on failure.
//! Build first: `cargo near build non-reproducible-wasm` in vault/ and factory/.
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

const VAULT_WASM: &str = "../target/near/trellis_vault/trellis_vault.wasm";
const FACTORY_WASM: &str = "../target/near/trellis_factory/trellis_factory.wasm";

#[tokio::test]
async fn factory_local_mode_creates_vault() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let admin = root.create_subaccount("admin").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let factory_acc = root.create_subaccount("trellis").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
    let factory = factory_acc.deploy(&std::fs::read(FACTORY_WASM)?).await?.into_result()?;
    factory.call("new").args_json(json!({ "admin": admin.id(), "mode": "Local" })).transact().await?.into_result()?;

    // upload the vault wasm as raw input
    admin.call(factory.id(), "set_code").args(std::fs::read(VAULT_WASM)?).gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    let min: String = factory.view("get_min_deposit").await?.json()?;
    println!("min deposit (local mode): {} NEAR", min.parse::<u128>()? as f64 / 1e24);

    // too little → rejected
    let r = alice.call(factory.id(), "create_vault").deposit(NearToken::from_near(1)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_failure());

    let r = alice.call(factory.id(), "create_vault").deposit(NearToken::from_near(6)).gas(Gas::from_tgas(300)).transact().await?;
    for f in r.receipt_failures() {
        println!("failure: {:?}", f.clone().into_result().err());
    }
    assert!(r.receipt_failures().is_empty());
    let vault: String = r.json::<Option<String>>()?.expect("vault id");
    println!("created {vault}");
    let vault: near_workspaces::AccountId = vault.parse()?;

    // initialized with alice as owner, no access keys on the vault
    let owner: String = worker.view(&vault, "get_owner").await?.json()?;
    assert_eq!(owner, alice.id().as_str());
    let keys = worker.view_access_keys(&vault).await?;
    assert!(keys.is_empty(), "vault must have no access keys");
    let got: Option<String> = factory.view("get_vault").args_json(json!({ "owner": alice.id() })).await?.json()?;
    assert_eq!(got.as_deref(), Some(vault.as_str()));

    // second vault for the same owner → rejected
    let r = alice.call(factory.id(), "create_vault").deposit(NearToken::from_near(6)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_failure());

    // the factory can't touch the vault: owner methods reject it
    let r = factory.as_account().call(&vault, "pause").deposit(NearToken::from_yoctonear(1)).transact().await?;
    assert!(r.is_failure(), "factory has no rights over the vault");
    Ok(())
}

/// Global mode: the admin publishes the vault code once (by hash); each vault then costs only ~1.5 NEAR.
#[tokio::test]
async fn factory_global_mode_creates_cheap_vault() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let admin = root.create_subaccount("admin").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let factory_acc = root.create_subaccount("trellis").initial_balance(NearToken::from_near(80)).transact().await?.into_result()?;
    let factory = factory_acc.deploy(&std::fs::read(FACTORY_WASM)?).await?.into_result()?;
    factory.call("new").args_json(json!({ "admin": admin.id(), "mode": "Local" })).transact().await?.into_result()?;

    // only the admin can publish
    let wasm = std::fs::read(VAULT_WASM)?;
    let r = alice.call(factory.id(), "publish_global_code").args(wasm.clone()).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_failure());

    let before = worker.view_account(factory.id()).await?.balance;
    let r = admin.call(factory.id(), "publish_global_code").args(wasm.clone()).gas(Gas::from_tgas(300)).transact().await?;
    for f in r.receipt_failures() {
        println!("failure: {:?}", f.clone().into_result().err());
    }
    assert!(r.receipt_failures().is_empty());
    assert!(r.json::<bool>()?, "publish callback should report success");
    let after = worker.view_account(factory.id()).await?.balance;
    let burned = (before.as_yoctonear() - after.as_yoctonear()) as f64 / 1e24;
    println!("published {} KB globally, factory paid {burned:.2} NEAR", wasm.len() / 1024);

    let mode: serde_json::Value = factory.view("get_mode").await?.json()?;
    println!("mode: {mode}");
    assert!(mode["Global"]["code_hash"].is_string());
    let min: String = factory.view("get_min_deposit").await?.json()?;
    let min_near = min.parse::<u128>()? as f64 / 1e24;
    println!("min deposit (global mode): {min_near} NEAR");
    assert!(min_near <= 1.5 + 1e-9);

    // create a vault with exactly the minimum deposit
    let r = alice.call(factory.id(), "create_vault").deposit(NearToken::from_yoctonear(min.parse()?)).gas(Gas::from_tgas(300)).transact().await?;
    for f in r.receipt_failures() {
        println!("failure: {:?}", f.clone().into_result().err());
    }
    assert!(r.receipt_failures().is_empty());
    let vault: near_workspaces::AccountId = r.json::<Option<String>>()?.expect("vault id").parse()?;
    let owner: String = worker.view(&vault, "get_owner").await?.json()?;
    assert_eq!(owner, alice.id().as_str());
    assert!(worker.view_access_keys(&vault).await?.is_empty(), "no keys on the vault");
    let st: serde_json::Value = worker.view(&vault, "get_status").await?.json()?;
    let avail = st["near_available"].as_str().unwrap().parse::<u128>()? as f64 / 1e24;
    println!("vault {vault} created; NEAR available in vault: {avail:.3}");
    assert!(avail > 1.0, "vault keeps most of the deposit for reserve + protocol storage");
    Ok(())
}

/// A failed creation (here: global mode pointing at code that was never published) refunds the
/// deposit, forgets the vault, and lets the owner try again.
#[tokio::test]
async fn factory_refunds_failed_creation() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let admin = root.create_subaccount("admin").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let factory_acc = root.create_subaccount("trellis").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
    let factory = factory_acc.deploy(&std::fs::read(FACTORY_WASM)?).await?.into_result()?;
    let bogus = near_workspaces::types::CryptoHash::default().to_string();
    factory.call("new").args_json(json!({ "admin": admin.id(), "mode": { "Global": { "code_hash": bogus } } })).transact().await?.into_result()?;

    let before = worker.view_account(alice.id()).await?.balance;
    let r = alice.call(factory.id(), "create_vault").deposit(NearToken::from_near(2)).gas(Gas::from_tgas(300)).transact().await?;
    assert_eq!(r.json::<Option<String>>()?, None, "creation must report failure");
    let got: Option<String> = factory.view("get_vault").args_json(json!({ "owner": alice.id() })).await?.json()?;
    assert!(got.is_none(), "failed vault is forgotten");

    // refunded right away, or recorded for claim_refund
    let pending: String = factory.view("get_refund").args_json(json!({ "owner": alice.id() })).await?.json()?;
    if pending != "0" {
        alice.call(factory.id(), "claim_refund").transact().await?.into_result()?;
    }
    let after = worker.view_account(alice.id()).await?.balance;
    let lost = (before.as_yoctonear() - after.as_yoctonear()) as f64 / 1e24;
    println!("refund path: {}, alice lost {lost:.4} NEAR to gas", if pending == "0" { "immediate" } else { "claim" });
    assert!(lost < 0.05, "deposit came back (lost {lost})");

    // and alice can try again: still fails (bad code) but not with ERR_VAULT_EXISTS
    let r = alice.call(factory.id(), "create_vault").deposit(NearToken::from_near(2)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.is_success(), "retry accepted: {:?}", r.failures());
    Ok(())
}

/// A testnet-style factory: every vault it creates is bound to the factory's own protocol contracts.
#[tokio::test]
async fn factory_passes_its_protocols_to_vaults() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let admin = root.create_subaccount("admin").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let factory_acc = root.create_subaccount("trellis").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
    let factory = factory_acc.deploy(&std::fs::read(FACTORY_WASM)?).await?.into_result()?;
    let protocols = json!({ "burrow": "burrow.trellis.test.near", "ref_exchange": "ref.trellis.test.near",
        "oracle": "oracle.trellis.test.near", "intents": "intents.near", "wrap": "wrap.test.near" });
    factory.call("new").args_json(json!({ "admin": admin.id(), "mode": "Local", "protocols": protocols })).transact().await?.into_result()?;
    admin.call(factory.id(), "set_code").args(std::fs::read(VAULT_WASM)?).gas(Gas::from_tgas(300)).transact().await?.into_result()?;

    let r = alice.call(factory.id(), "create_vault").deposit(NearToken::from_near(6)).gas(Gas::from_tgas(300)).transact().await?;
    assert!(r.receipt_failures().is_empty());
    let vault: near_workspaces::AccountId = r.json::<Option<String>>()?.expect("vault id").parse()?;
    let got: serde_json::Value = worker.view(&vault, "get_protocols").await?.json()?;
    assert_eq!(got, protocols, "the vault is bound to the factory's protocols");
    let f: serde_json::Value = factory.view("get_protocols").await?.json()?;
    assert_eq!(f, protocols);
    Ok(())
}

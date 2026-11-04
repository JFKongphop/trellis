//! Shared sandbox setup: real mainnet wasm for wrap.near, Ref v2 and Burrow (imported at their real
//! ids), mock USDC at the real USDC id, mock oracle at aggregate-oracle.near, and a Trellis vault.
#![allow(dead_code)]
use near_workspaces::network::{Mainnet, Sandbox};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{AccessKey, Account, AccountDetailsPatch, AccountId, Contract, Worker};
use serde_json::{json, Value};

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
pub const WNEAR: &str = "wrap.near";
pub const NEAR_PID: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
pub const USDC_PID: &str = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
pub const E24: u128 = 1_000_000_000_000_000_000_000_000;

const VAULT_WASM: &str = "../target/near/trellis_vault/trellis_vault.wasm";
const ORACLE_WASM: &str = "../target/near/mock_oracle/mock_oracle.wasm";
const FT_WASM: &[u8] = include_bytes!("../../res/fungible_token.wasm");

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub alice: Account,
    pub agent: Account,
    pub mallory: Account,
    pub wrap: Contract,
    pub usdc: Contract,
    pub refx: Contract,
    pub burrow: Contract,
    pub oracle: Contract,
    pub vault: Contract,
    pub pool_id: u64,
    /// A wNEAR/FAKE pool, used to test that an allowlisted pool id with the wrong pair is rejected.
    pub fake_pool_id: u64,
}

/// Mainnet code is downloaded once into `target/mainnet-cache/` and reused (delete the folder to
/// refresh). Parallel tests importing from the public RPC on every run get rate-limited.
const MAINNET_CACHE: &str = "../target/mainnet-cache";

async fn mainnet_code(mainnet: &Worker<Mainnet>, id: &AccountId) -> anyhow::Result<Vec<u8>> {
    let path = std::path::Path::new(MAINNET_CACHE).join(format!("{id}.wasm"));
    if let Ok(code) = std::fs::read(&path) {
        return Ok(code);
    }
    let mut last = None;
    for attempt in 0..6u64 {
        match mainnet.view_code(id).await {
            Ok(code) => {
                std::fs::create_dir_all(MAINNET_CACHE)?;
                // write to a temp file first so a parallel test never reads half a file
                let tmp = path.with_extension(format!("tmp{}", std::process::id()));
                std::fs::write(&tmp, &code)?;
                std::fs::rename(&tmp, &path)?;
                return Ok(code);
            }
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(500 * (1 << attempt))).await;
            }
        }
    }
    Err(anyhow::anyhow!("download {id} from mainnet: {:?}", last))
}

async fn spoon(worker: &Worker<Sandbox>, mainnet: &Worker<Mainnet>, id: &str) -> anyhow::Result<Contract> {
    let id: AccountId = id.parse()?;
    let code = mainnet_code(mainnet, &id).await?;
    let c = deploy_at(worker, id.as_str(), &code).await?;
    let code_len = code.len() as u64;
    worker
        .patch(&id)
        .account_from_current(move |cur| AccountDetailsPatch::from(cur).storage_usage(code_len + 10_000))
        .transact()
        .await?;
    Ok(c)
}

async fn deploy_at(worker: &Worker<Sandbox>, id: &str, wasm: &[u8]) -> anyhow::Result<Contract> {
    let id: AccountId = id.parse()?;
    let sk = SecretKey::from_random(KeyType::ED25519);
    worker
        .patch(&id)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(100)))
        .access_key(sk.public_key(), AccessKey::full_access())
        .code(wasm)
        .transact()
        .await?;
    Ok(Contract::from_secret_key(id, sk, worker))
}

async fn sub(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

pub async fn ft_register(payer: &Account, token: &AccountId, who: &AccountId) -> anyhow::Result<()> {
    payer
        .call(token, "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(125))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Prints every receipt (executor, gas, failures, Trellis/Burrow events). Returns failure count.
pub fn report(label: &str, res: &ExecutionFinalResult) -> usize {
    let failures = res.receipt_failures().len();
    println!("--- {label}: top-level success={} receipt_failures={}", res.is_success(), failures);
    for o in res.receipt_outcomes() {
        let fail = if o.is_failure() { "  FAILED" } else { "" };
        println!("    {:<28} {:>6.1} Tgas{}", short(o.executor_id.as_str()), o.gas_burnt.as_gas() as f64 / 1e12, fail);
        for l in &o.logs {
            if l.contains("trellis_vault") || l.contains("\"event\":\"borrow\"") || l.contains("sync") {
                println!("        {}", truncate(l, 260));
            }
        }
    }
    for f in res.receipt_failures() {
        println!("    failure: {}", truncate(&format!("{:?}", f.clone().into_result().err()), 300));
    }
    failures
}

/// Sum of gas burnt across all receipts, in Tgas.
pub fn total_tgas(res: &ExecutionFinalResult) -> f64 {
    res.total_gas_burnt.as_gas() as f64 / 1e12
}

fn short(s: &str) -> String {
    if s.len() > 28 { format!("{}…", &s[..27]) } else { s.to_string() }
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() > n { format!("{}…", &s[..n]) } else { s.to_string() }
}

/// All "trellis_vault" events emitted by successful receipts.
pub fn vault_events(res: &ExecutionFinalResult) -> Vec<Value> {
    res.receipt_outcomes()
        .iter()
        .filter(|o| !o.is_failure())
        .flat_map(|o| o.logs.iter())
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter(|v| v["standard"] == "trellis_vault")
        .collect()
}

pub fn has_event(res: &ExecutionFinalResult, name: &str) -> bool {
    vault_events(res).iter().any(|e| e["event"] == name)
}

pub fn event_data(res: &ExecutionFinalResult, name: &str) -> Option<Value> {
    vault_events(res).into_iter().find(|e| e["event"] == name).map(|e| e["data"].clone())
}

impl Env {
    pub async fn new() -> anyhow::Result<Env> {
        let vault_wasm = std::fs::read(VAULT_WASM).map_err(|e| anyhow::anyhow!("{VAULT_WASM}: {e} (run `cargo near build` in vault/)"))?;
        let oracle_wasm = std::fs::read(ORACLE_WASM).map_err(|e| anyhow::anyhow!("{ORACLE_WASM}: {e} (run `cargo near build` in mock-oracle/)"))?;

        let worker = near_workspaces::sandbox().await?;
        let mainnet: Worker<Mainnet> = near_workspaces::mainnet().rpc_addr("https://rpc.mainnet.fastnear.com").await?;
        let root = worker.root_account()?;
        let alice = sub(&root, "alice", 500).await?;
        let agent = sub(&root, "agent", 50).await?;
        let mallory = sub(&root, "mallory", 50).await?;

        // wrap.near (real code)
        let wrap = spoon(&worker, &mainnet, WNEAR).await?;
        root.call(wrap.id(), "new").transact().await?.into_result()?;
        for a in [&root, &alice] {
            ft_register(a, wrap.id(), a.id()).await?;
            a.call(wrap.id(), "near_deposit").deposit(NearToken::from_near(200)).transact().await?.into_result()?;
        }

        // mock USDC at the real id, 1,000,000 USDC to root
        let usdc = deploy_at(&worker, USDC, FT_WASM).await?;
        usdc.call("new")
            .args_json(json!({ "owner_id": root.id(), "total_supply": "1000000000000",
                "metadata": { "spec": "ft-1.0.0", "name": "Mock USDC", "symbol": "USDC", "decimals": 6 } }))
            .transact()
            .await?
            .into_result()?;
        ft_register(&root, usdc.id(), alice.id()).await?;

        // a fake token for the wrong-pair pool test
        let fake = root.create_subaccount("fake").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
        let fake = fake.deploy(FT_WASM).await?.into_result()?;
        fake.call("new")
            .args_json(json!({ "owner_id": root.id(), "total_supply": "1000000000000",
                "metadata": { "spec": "ft-1.0.0", "name": "Fake", "symbol": "FAKE", "decimals": 6 } }))
            .transact()
            .await?
            .into_result()?;

        // mock oracle at aggregate-oracle.near
        let oracle = deploy_at(&worker, "aggregate-oracle.near", &oracle_wasm).await?;
        oracle.call("new").args_json(json!({ "owner": root.id() })).transact().await?.into_result()?;

        // Ref v2 (real code): pool wNEAR/USDC at 5 USDC per NEAR, and a wNEAR/FAKE pool
        let refx = spoon(&worker, &mainnet, "v2.ref-finance.near").await?;
        root.call(refx.id(), "new")
            .args_json(json!({ "owner_id": root.id(), "boost_farm_id": "boostfarm.ref-labs.near",
                "burrowland_id": "contract.main.burrow.near", "exchange_fee": 2000, "referral_fee": 0 }))
            .transact()
            .await?
            .into_result()?;
        root.call(refx.id(), "storage_deposit").args_json(json!({})).deposit(NearToken::from_near(1)).transact().await?.into_result()?;
        root.call(refx.id(), "extend_whitelisted_tokens")
            .args_json(json!({ "tokens": [wrap.id(), usdc.id(), fake.id()] }))
            .deposit(ONE_YOCTO)
            .transact()
            .await?
            .into_result()?;
        let pool_id: u64 = root
            .call(refx.id(), "add_simple_pool")
            .args_json(json!({ "tokens": [wrap.id(), usdc.id()], "fee": 30 }))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await?
            .json()?;
        let fake_pool_id: u64 = root
            .call(refx.id(), "add_simple_pool")
            .args_json(json!({ "tokens": [wrap.id(), fake.id()], "fee": 30 }))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await?
            .json()?;
        for t in [wrap.id(), usdc.id(), fake.id()] {
            ft_register(&root, t, refx.id()).await?;
        }
        for (tok, amt) in [(wrap.id(), "150000000000000000000000000"), (usdc.id(), "500000000"), (fake.id(), "500000000")] {
            root.call(tok, "ft_transfer_call")
                .args_json(json!({ "receiver_id": refx.id(), "amount": amt, "msg": "" }))
                .deposit(ONE_YOCTO)
                .gas(Gas::from_tgas(100))
                .transact()
                .await?
                .into_result()?;
        }
        // 100 wNEAR : 500 USDC → $5/NEAR; 50 wNEAR : 500 FAKE
        root.call(refx.id(), "add_liquidity")
            .args_json(json!({ "pool_id": pool_id, "amounts": ["100000000000000000000000000", "500000000"] }))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await?
            .into_result()?;
        root.call(refx.id(), "add_liquidity")
            .args_json(json!({ "pool_id": fake_pool_id, "amounts": ["50000000000000000000000000", "500000000"] }))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await?
            .into_result()?;

        // Burrow (real code) with the live mainnet config and asset configs
        let burrow = spoon(&worker, &mainnet, "contract.main.burrow.near").await?;
        let burrow_id: AccountId = "contract.main.burrow.near".parse()?;
        let mut config: Value = mainnet.view(&burrow_id, "get_config").await?.json()?;
        config["owner_id"] = json!(root.id());
        root.call(burrow.id(), "new").args_json(json!({ "config": config })).max_gas().transact().await?.into_result()?;
        for tok in [wrap.id(), usdc.id()] {
            let asset: Value = mainnet.view(&burrow_id, "get_asset").args_json(json!({ "token_id": tok })).await?.json()?;
            let mut cfg = asset["config"].clone();
            cfg["beneficiaries"] = json!({});
            root.call(burrow.id(), "add_asset")
                .args_json(json!({ "token_id": tok, "asset_config": cfg }))
                .deposit(ONE_YOCTO)
                .max_gas()
                .transact()
                .await?
                .into_result()?;
            let pyth: Value = mainnet.view(&burrow_id, "get_token_pyth_info").args_json(json!({ "token_id": tok })).await?.json()?;
            root.call(burrow.id(), "add_token_pyth_info")
                .args_json(json!({ "token_id": tok, "token_pyth_info": pyth }))
                .deposit(ONE_YOCTO)
                .transact()
                .await?
                .into_result()?;
            ft_register(&root, tok, burrow.id()).await?;
        }
        root.call(burrow.id(), "storage_deposit").args_json(json!({})).deposit(NearToken::from_millinear(250)).transact().await?.into_result()?;
        // 10,000 USDC of borrowable liquidity
        root.call(usdc.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": burrow.id(), "amount": "10000000000", "msg": "" }))
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(150))
            .transact()
            .await?
            .into_result()?;

        // the vault, owned by alice
        let vault_acc = root.create_subaccount("vault").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
        let vault = vault_acc.deploy(&vault_wasm).await?.into_result()?;
        vault.call("new").args_json(json!({ "owner": alice.id() })).transact().await?.into_result()?;

        let env = Env { worker, root, alice, agent, mallory, wrap, usdc, refx, burrow, oracle, vault, pool_id, fake_pool_id };
        env.set_prices("500000000", 0).await?;
        Ok(env)
    }

    /// NEAR price (1e-8 USD) and USDC = $1, published `offset_sec` from now.
    pub async fn set_prices(&self, near_e8: &str, offset_sec: i64) -> anyhow::Result<()> {
        let now = (self.worker.view_block().await?.timestamp() / 1_000_000_000) as i64 + offset_sec;
        for (id, price) in [(NEAR_PID, near_e8), (USDC_PID, "100000000")] {
            self.root
                .call(self.oracle.id(), "set_price")
                .args_json(json!({ "price_identifier": id,
                    "pyth_price": { "price": price, "conf": "50000", "expo": -8, "publish_time": now } }))
                .transact()
                .await?
                .into_result()?;
        }
        Ok(())
    }

    pub fn policy(&self) -> Value {
        json!({
            "allowed_tokens": [WNEAR, USDC],
            "allowed_ref_pools": [self.pool_id, self.fake_pool_id],
            "per_action_cap": [[WNEAR, (20 * E24).to_string()], [USDC, "100000000"]],
            "daily_cap": [[WNEAR, (50 * E24).to_string()], [USDC, "300000000"]],
            "max_slippage_bps": 200,
            "max_intents_spread_bps": 50,
            "min_health_factor_bps": 15000,
            "deleverage_trigger_bps": 13000,
            "emergency_floor_bps": 11000,
            "max_price_age_sec": 60,
            "max_price_conf_bps": 100,
            "burrow_enabled": true,
            "ref_enabled": true,
            "intents_enabled": false,
            "intents_quote_pubkey": null,
            "min_near_reserve": NearToken::from_millinear(500).as_yoctonear().to_string(),
            "max_storage_spend": NearToken::from_near(2).as_yoctonear().to_string(),
        })
    }

    /// Owner call (1 yocto attached).
    pub async fn owner(&self, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self.alice.call(self.vault.id(), method).args_json(args).deposit(ONE_YOCTO).gas(Gas::from_tgas(300)).transact().await?)
    }

    /// Agent call (no deposit, 300 Tgas).
    pub async fn agent(&self, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self.agent.call(self.vault.id(), method).args_json(args).gas(Gas::from_tgas(300)).transact().await?)
    }

    /// Full owner setup: policy, agent, tokens, protocol storage, and 40 wNEAR deposited.
    pub async fn configure(&self) -> anyhow::Result<()> {
        self.owner("set_policy", json!({ "policy": self.policy() })).await?.into_result()?;
        self.owner("set_agent", json!({ "agent": self.agent.id() })).await?.into_result()?;
        for t in [WNEAR, USDC] {
            let r = self.owner("register_token", json!({ "token": t })).await?;
            assert_eq!(report(&format!("register_token {t}"), &r), 0);
            assert_eq!(r.json::<bool>()?, true, "register_token {t} callback returned false");
        }
        let r = self.owner("setup_protocols", json!({})).await?;
        assert_eq!(report("setup_protocols", &r), 0);
        // alice deposits 40 wNEAR into the vault
        self.alice
            .call(self.wrap.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": self.vault.id(), "amount": (40 * E24).to_string(), "msg": "" }))
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn balance(&self, token: &str, who: &AccountId) -> anyhow::Result<u128> {
        let t: AccountId = token.parse()?;
        let s: String = self.worker.view(&t, "ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
        Ok(s.parse()?)
    }

    pub async fn positions(&self) -> anyhow::Result<Value> {
        Ok(self.burrow.view("get_account_all_positions").args_json(json!({ "account_id": self.vault.id() })).await?.json()?)
    }

    pub async fn status(&self) -> anyhow::Result<Value> {
        Ok(self.vault.view("get_status").await?.json()?)
    }

    /// Let at least MIN_SYNC_DELAY pass, then refresh prices (sandbox time is wall clock).
    pub async fn wait_for_sync(&self, near_e8: &str) -> anyhow::Result<()> {
        self.worker.fast_forward(20).await?;
        tokio::time::sleep(std::time::Duration::from_millis(5_500)).await;
        self.set_prices(near_e8, 0).await
    }
}

pub fn debt_shares(pos: &Value, token: &str) -> u128 {
    pos["positions"]["REGULAR"]["borrowed"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["token_id"] == token))
        .and_then(|x| x["shares"].as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

pub fn collateral_balance(pos: &Value, token: &str) -> u128 {
    pos["positions"]["REGULAR"]["collateral"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["token_id"] == token))
        .and_then(|x| x["balance"].as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

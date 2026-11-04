//! Demo launcher (not a test; `#[ignore]`d). Started by `pnpm demo` (demo/run.mjs):
//!   cargo test -p integration-tests --test demo -- --ignored --nocapture
//!
//! Brings up a local NEAR sandbox with real Rhea (Burrow), Ref and wNEAR code at their mainnet ids,
//! the Trellis factory, a demo user (alice.test.near) with a vault created through the factory,
//! rules set, the agent authorized, the Trellis worker running, and a leveraged position built
//! through an owner-approved plan. Then it keeps oracle prices fresh and serves a tiny control
//! API so the web app can "crash" the NEAR price. Writes everything the web app needs to
//! DEMO_STATE_FILE and prints `DEMO_READY <path>`. Runs until killed.
mod common;

use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use near_workspaces::types::{AccessKey, Gas, NearToken, PublicKey};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SEED: &str = "trellis-demo-seed-local-sandbox-only";
const TOKEN: &str = "demo-worker-token";
const WORKER_DIR: &str = "../../worker";
const FACTORY_WASM: &str = "../target/near/trellis_factory/trellis_factory.wasm";
const VAULT_WASM: &str = "../target/near/trellis_vault/trellis_vault.wasm";
const START_PRICE_E8: &str = "500000000"; // $5.00

struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

#[tokio::test]
#[ignore = "demo launcher, run via `pnpm demo`"]
async fn demo() -> anyhow::Result<()> {
    let state_file = std::env::var("DEMO_STATE_FILE").unwrap_or_else(|_| "../../demo/.state.json".into());
    let worker_port: u16 = std::env::var("DEMO_WORKER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8787);
    let control_port: u16 = std::env::var("DEMO_CONTROL_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8788);
    step("starting sandbox (real Rhea, Ref and wNEAR code; first run downloads it from mainnet)");
    let env = Env::new().await?;

    // deeper wNEAR/USDC pool so the demo's swaps stay inside the 2% slippage rule
    step("adding liquidity to the Ref wNEAR/USDC pool");
    env.root.call(env.wrap.id(), "near_deposit").deposit(NearToken::from_near(1_000)).transact().await?.into_result()?;
    for (tok, amt) in [(env.wrap.id(), (1_000 * E24).to_string()), (env.usdc.id(), "5000000000".to_string())] {
        env.root
            .call(tok, "ft_transfer_call")
            .args_json(json!({ "receiver_id": env.refx.id(), "amount": amt, "msg": "" }))
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
    }
    env.root
        .call(env.refx.id(), "add_liquidity")
        .args_json(json!({ "pool_id": env.pool_id, "amounts": [(1_000 * E24).to_string(), "5000000000"] }))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    // give alice some USDC to play with in wallet mode
    env.root
        .call(env.usdc.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": env.alice.id(), "amount": "100000000" }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;

    // factory (local code mode) + alice's vault through it, exactly like the web flow
    step("deploying the Trellis factory and creating alice's vault");
    let factory_acc = env.root.create_subaccount("trellis").initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let factory = factory_acc.deploy(&std::fs::read(FACTORY_WASM)?).await?.into_result()?;
    factory.call("new").args_json(json!({ "admin": env.root.id(), "mode": "Local" })).transact().await?.into_result()?;
    env.root.call(factory.id(), "set_code").args(std::fs::read(VAULT_WASM)?).gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    let r = env.alice.call(factory.id(), "create_vault").deposit(NearToken::from_near(8)).gas(Gas::from_tgas(300)).transact().await?;
    let vault: AccountId = r.json::<Option<String>>()?.ok_or_else(|| anyhow::anyhow!("create_vault failed"))?.parse()?;

    step("setting rules, registering tokens, authorizing the agent");
    let owner = |method: &'static str, args: Value| {
        let (alice, vault) = (env.alice.clone(), vault.clone());
        async move { alice.call(&vault, method).args_json(args).deposit(ONE_YOCTO).gas(Gas::from_tgas(300)).transact().await }
    };
    let mut policy = env.policy();
    policy["allowed_ref_pools"] = json!([env.pool_id]);
    owner("set_policy", json!({ "policy": policy })).await?.into_result()?;
    owner("set_agent", json!({ "agent": env.agent.id() })).await?.into_result()?;
    for t in [WNEAR, USDC] {
        let r = owner("register_token", json!({ "token": t })).await?;
        anyhow::ensure!(r.json::<bool>()?, "register_token {t} failed");
    }
    owner("setup_protocols", json!({})).await?.into_result()?;
    env.alice
        .call(env.wrap.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": vault, "amount": (25 * E24).to_string(), "msg": "" }))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

    // the worker's per-vault function-call key on the agent account
    step("provisioning the worker key and starting the worker");
    let out = Command::new("pnpm")
        .args(["--silent", "provision", vault.as_str()])
        .current_dir(WORKER_DIR)
        .env("AGENT_KEY_SEED", SEED)
        .env("AGENT_ACCOUNT_ID", env.agent.id().as_str())
        .output()?;
    let stdout = String::from_utf8(out.stdout)?;
    let pk = stdout
        .lines()
        .find_map(|l| l.split(": ").nth(1).filter(|s| s.starts_with("ed25519:")))
        .ok_or_else(|| anyhow::anyhow!("provision output had no key: {stdout}"))?;
    let pk: PublicKey = pk.trim().parse()?;
    let methods = [
        "agent_wrap_near", "agent_supply", "agent_repay", "agent_borrow", "agent_withdraw_collateral", "agent_withdraw_supplied",
        "agent_swap_ref", "recover_ref", "agent_route_intents", "agent_intents_withdraw", "sync_position",
    ];
    env.agent
        .batch(env.agent.id())
        .add_key(pk, AccessKey::function_call_access(&vault, &methods, Some(NearToken::from_near(2))))
        .transact()
        .await?
        .into_result()?;

    let data_dir = std::env::temp_dir().join(format!("trellis-demo-{}", std::process::id()));
    std::fs::create_dir_all(&data_dir)?;
    let log_path = data_dir.join("worker.log");
    let log = std::fs::File::create(&log_path)?;
    let _worker = KillOnDrop(
        Command::new("node_modules/.bin/tsx")
            .args(["src/index.ts"])
            .current_dir(WORKER_DIR)
            .env("RPC_URL", env.worker.rpc_addr())
            .env("AGENT_ACCOUNT_ID", env.agent.id().as_str())
            .env("AGENT_KEY_SEED", SEED)
            .env("VAULTS", vault.as_str())
            .env("WORKER_API_TOKEN", TOKEN)
            .env("PORT", worker_port.to_string())
            .env("TICK_MS", "3000")
            .env("DATA_DIR", &data_dir)
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()?,
    );

    // oracle prices must stay fresh (max age 60 s): republish the current price every 15 s
    let price = Arc::new(Mutex::new(START_PRICE_E8.to_string()));
    spawn_price_keeper(env.worker.clone(), env.root.clone(), env.oracle.id().clone(), price.clone());
    publish(&env.worker, &env.root, env.oracle.id(), START_PRICE_E8).await?;

    // leveraged position through an owner-approved plan (shows up as "Owner-approved" in the app)
    step("building a leveraged position (owner-approved plan: supply, borrow, swap, supply)");
    let api = format!("127.0.0.1:{worker_port}");
    wait_for_worker(&api).await?;
    http(&api, "POST", "/vaults", Some(json!({ "vaultId": vault, "owner": env.alice.id() }))).await?;
    let plan = json!({
        "planId": "demo-setup", "vaultId": vault, "owner": env.alice.id(),
        "reasoning": "Demo setup: open a ~1.25x leveraged wNEAR position",
        "steps": [
            { "method": "agent_supply", "args": { "token": WNEAR, "amount": (20 * E24).to_string() }, "label": "Supply 20 wNEAR as collateral" },
            { "method": "agent_borrow", "args": { "token": USDC, "amount": "30000000" }, "label": "Borrow 30 USDC" },
            { "method": "agent_swap_ref", "args": { "pool_id": env.pool_id, "token_in": USDC, "token_out": WNEAR, "amount_in": "30000000" }, "label": "Swap 30 USDC → wNEAR" },
            { "method": "agent_supply", "args": { "token": WNEAR, "amount": (10 * E24).to_string() }, "label": "Supply 10 wNEAR as collateral" },
        ],
    });
    http(&api, "POST", "/plans", Some(plan)).await?;
    let mut status = Value::Null;
    for _ in 0..90 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        status = http(&api, "GET", "/plans/demo-setup", None).await?;
        if status["status"] == "done" || status["status"] == "failed" {
            break;
        }
    }
    anyhow::ensure!(status["status"] == "done", "setup plan didn't finish: {status} (worker log: {})", log_path.display());

    // control API for the web app
    let control = tokio::net::TcpListener::bind(("127.0.0.1", control_port)).await?;
    spawn_control(control, env.worker.clone(), env.root.clone(), env.oracle.id().clone(), price.clone());

    let state = json!({
        "rpcUrl": env.worker.rpc_addr(),
        "accountId": env.alice.id(),
        "secretKey": env.alice.secret_key().to_string(),
        "factory": factory.id(),
        "agent": env.agent.id(),
        "vault": vault,
        "workerUrl": format!("http://{api}"),
        "workerToken": TOKEN,
        "controlUrl": format!("http://127.0.0.1:{control_port}"),
        "workerLog": log_path,
        "startPriceE8": START_PRICE_E8,
    });
    if let Some(dir) = std::path::Path::new(&state_file).parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&state_file, serde_json::to_string_pretty(&state)?)?;
    let abs = std::fs::canonicalize(&state_file)?;
    println!("DEMO_READY {}", abs.display());

    // run until killed
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

fn step(s: &str) {
    println!("DEMO_STEP {s}");
}

async fn publish(worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>, root: &Account, oracle: &AccountId, near_e8: &str) -> anyhow::Result<()> {
    let now = (worker.view_block().await?.timestamp() / 1_000_000_000) as i64;
    for (id, px) in [(NEAR_PID, near_e8), (USDC_PID, "100000000")] {
        root.call(oracle, "set_price")
            .args_json(json!({ "price_identifier": id, "pyth_price": { "price": px, "conf": "50000", "expo": -8, "publish_time": now } }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(())
}

fn spawn_price_keeper(
    worker: near_workspaces::Worker<near_workspaces::network::Sandbox>,
    root: Account,
    oracle: AccountId,
    price: Arc<Mutex<String>>,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let p = price.lock().unwrap().clone();
            let _ = publish(&worker, &root, &oracle, &p).await;
        }
    });
}

/// GET /state → {"nearE8"}; POST /price {"nearE8": "<digits>"} → publish now.
fn spawn_control(
    listener: tokio::net::TcpListener,
    worker: near_workspaces::Worker<near_workspaces::network::Sandbox>,
    root: Account,
    oracle: AccountId,
    price: Arc<Mutex<String>>,
) {
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { continue };
            let (worker, root, oracle, price) = (worker.clone(), root.clone(), oracle.clone(), price.clone());
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let mut n = 0;
                // read headers (+ small body)
                while n < buf.len() {
                    match sock.read(&mut buf[n..]).await {
                        Ok(0) | Err(_) => break,
                        Ok(k) => n += k,
                    }
                    let text = String::from_utf8_lossy(&buf[..n]);
                    if let Some(h) = text.find("\r\n\r\n") {
                        let len = text[..h]
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if n >= h + 4 + len {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                let first = text.lines().next().unwrap_or("").to_string();
                let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                let (code, reply) = if first.starts_with("GET /state") {
                    (200, json!({ "nearE8": price.lock().unwrap().clone() }))
                } else if first.starts_with("POST /price") {
                    let want = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["nearE8"].as_str().map(String::from));
                    match want.filter(|s| !s.is_empty() && s.len() < 15 && s.chars().all(|c| c.is_ascii_digit()) && s != "0") {
                        Some(p) => {
                            *price.lock().unwrap() = p.clone();
                            match publish(&worker, &root, &oracle, &p).await {
                                Ok(()) => (200, json!({ "nearE8": p })),
                                Err(e) => (500, json!({ "error": e.to_string() })),
                            }
                        }
                        None => (400, json!({ "error": "nearE8 must be a positive integer string" })),
                    }
                } else {
                    (404, json!({ "error": "not found" }))
                };
                let b = reply.to_string();
                let resp = format!("HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
}

async fn wait_for_worker(addr: &str) -> anyhow::Result<()> {
    for _ in 0..60 {
        if tokio::net::TcpStream::connect(addr).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    anyhow::bail!("worker didn't start on {addr}")
}

/// Minimal HTTP client for the worker API (bearer token).
async fn http(addr: &str, method: &str, path: &str, body: Option<Value>) -> anyhow::Result<Value> {
    let mut s = tokio::net::TcpStream::connect(addr).await?;
    let b = body.map(|v| v.to_string()).unwrap_or_default();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",
        b.len()
    );
    s.write_all(req.as_bytes()).await?;
    let mut resp = String::new();
    s.read_to_string(&mut resp).await?;
    let json = resp.split("\r\n\r\n").nth(1).unwrap_or("null");
    Ok(serde_json::from_str(json).unwrap_or(Value::Null))
}

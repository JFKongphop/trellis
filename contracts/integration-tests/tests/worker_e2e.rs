//! End-to-end: the real Node worker (trellis/worker) running against the sandbox.
//! 1. Build a leveraged position in a vault. 2. Give the worker its per-vault function-call key.
//! 3. Crash the NEAR price → the worker must deleverage on its own until HF >= min (1.5).
//! 4. Queue an owner-approved plan over the HTTP API → the worker runs it.
//! Needs: wasm built, `pnpm install` in worker/, Node 22+.
mod common;

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use common::*;
use near_workspaces::types::{AccessKey, NearToken, PublicKey};
use serde_json::{json, Value};

const SEED: &str = "trellis-e2e-test-seed-not-secret";
const TOKEN: &str = "e2e-token";
const WORKER_DIR: &str = "../../worker";

struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

fn hf_of(pos: &Value, near_price: f64) -> f64 {
    let coll = collateral_balance(pos, WNEAR) as f64 / 1e24 * near_price * 0.75;
    let debt = pos["positions"]["REGULAR"]["borrowed"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["token_id"] == USDC))
        .and_then(|x| x["balance"].as_str())
        .map(|s| s.parse::<f64>().unwrap() / 1e18)
        .unwrap_or(0.0);
    if debt == 0.0 { f64::INFINITY } else { coll / (debt / 0.95) }
}

#[tokio::test]
async fn worker_deleverages_and_runs_plans() -> anyhow::Result<()> {
    let env = Env::new().await?;
    env.configure().await?;
    let vault = env.vault.id().clone();

    // leveraged position: 20 wNEAR collateral, 20 USDC debt (HF ≈ 3.56 at $5)
    env.agent("agent_supply", json!({ "token": WNEAR, "amount": (20 * E24).to_string(), "reason_hash": "s" })).await?.into_result()?;
    env.agent("agent_borrow", json!({ "token": USDC, "amount": "20000000", "reason_hash": "b" })).await?.into_result()?;
    env.wait_for_sync("500000000").await?;
    env.agent("sync_position", json!({})).await?.into_result()?;
    // owner takes the borrowed USDC out, so the worker can't just repay from idle funds:
    // it must run the full withdraw → swap → repay cycle
    let idle = env.balance(USDC, &vault).await?;
    env.owner("withdraw_ft", json!({ "token": USDC, "amount": idle.to_string() })).await?.into_result()?;
    assert_eq!(env.balance(USDC, &vault).await?, 0);

    // the worker derives the vault key from SEED; add it to the agent account as a function-call key
    let out = Command::new("pnpm")
        .args(["--silent", "provision", vault.as_str()])
        .current_dir(WORKER_DIR)
        .env("AGENT_KEY_SEED", SEED)
        .env("AGENT_ACCOUNT_ID", env.agent.id().as_str())
        .output()?;
    let stdout = String::from_utf8(out.stdout)?;
    let pk_str = stdout.lines().find_map(|l| l.split(": ").nth(1).filter(|s| s.starts_with("ed25519:"))).expect("public key in provision output");
    let pk: PublicKey = pk_str.trim().parse()?;
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

    // start the worker against the sandbox RPC
    let data_dir = std::env::temp_dir().join(format!("trellis-e2e-{}", std::process::id()));
    let log_path = data_dir.with_extension("log");
    std::fs::create_dir_all(&data_dir)?;
    let log_file = std::fs::File::create(&log_path)?;
    println!("worker log: {}", log_path.display());
    // run tsx directly (not via pnpm) so killing the child really stops the worker
    let port: u16 = 20_000 + (std::process::id() % 20_000) as u16;
    let _worker = KillOnDrop(
        Command::new("node_modules/.bin/tsx")
            .args(["src/index.ts"])
            .current_dir(WORKER_DIR)
            .env("RPC_URL", env.worker.rpc_addr())
            .env("AGENT_ACCOUNT_ID", env.agent.id().as_str())
            .env("AGENT_KEY_SEED", SEED)
            .env("VAULTS", vault.as_str())
            .env("WORKER_API_TOKEN", TOKEN)
            .env("PORT", port.to_string())
            .env("TICK_MS", "3000")
            .env("DATA_DIR", &data_dir)
            .stdout(Stdio::from(log_file.try_clone()?))
            .stderr(Stdio::from(log_file))
            .spawn()?,
    );

    // keep oracle prices fresh in the background (sandbox time is wall clock, max age 60 s)
    let price = std::sync::Arc::new(std::sync::Mutex::new("240000000".to_string()));
    {
        let (root, oracle, w, price) = (env.root.clone(), env.oracle.id().clone(), env.worker.clone(), price.clone());
        tokio::spawn(async move {
            loop {
                let p = price.lock().unwrap().clone();
                let now = (w.view_block().await.map(|b| b.timestamp()).unwrap_or(0) / 1_000_000_000) as i64;
                for (id, px) in [(NEAR_PID, p.as_str()), (USDC_PID, "100000000")] {
                    let _ = root
                        .call(&oracle, "set_price")
                        .args_json(json!({ "price_identifier": id, "pyth_price": { "price": px, "conf": "50000", "expo": -8, "publish_time": now } }))
                        .transact()
                        .await;
                }
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
    }

    // crash: NEAR $5 → $2.40 gives HF ≈ 1.71 (still above the 1.3 trigger), so go to $1.80 if needed
    env.set_prices("240000000", 0).await?;
    let hf0 = hf_of(&env.positions().await?, 2.4);
    println!("HF at $2.40: {hf0:.3}");

    // if HF is still above the 1.3 trigger, push lower so the worker must act
    let crash_price = if hf0 >= 1.3 { "180000000" } else { "240000000" };
    *price.lock().unwrap() = crash_price.to_string();
    env.set_prices(crash_price, 0).await?;
    let p = crash_price.parse::<f64>()? / 1e8;
    let hf1 = hf_of(&env.positions().await?, p);
    println!("HF at ${p}: {hf1:.3} (trigger 1.3, floor 1.1)");
    assert!(hf1 < 1.3 && hf1 > 1.1);

    let start = Instant::now();
    let mut last = hf1;
    while start.elapsed() < Duration::from_secs(240) {
        tokio::time::sleep(Duration::from_secs(5)).await;
        last = hf_of(&env.positions().await?, p);
        println!("  t+{:>3}s HF {:.3}", start.elapsed().as_secs(), last);
        if last >= 1.5 {
            break;
        }
    }
    let receipts: Value = env.vault.view("get_receipts").args_json(json!({ "limit": 10 })).await?.json()?;
    for r in receipts.as_array().unwrap().iter().rev() {
        println!("  receipt: {} {} out={} note={}", r["kind"], r["status"], r["amount_out"], r["note"]);
    }
    assert!(last >= 1.5, "worker should restore HF >= 1.5 (got {last:.3}); see {}", log_path.display());
    let kinds: Vec<String> = receipts.as_array().unwrap().iter().map(|r| r["kind"].as_str().unwrap_or("").to_string()).collect();
    for k in ["WithdrawCollateral", "SwapRef", "Repay"] {
        assert!(kinds.iter().any(|x| x == k), "expected a {k} step in the deleverage cycle: {kinds:?}");
    }
    // the vault's own deleverage record closed once the proceeds were repaid
    let st: Value = env.vault.view("get_status").await?.json()?;
    assert!(st["pending_deleverage"].is_null(), "deleverage cycle should be closed: {}", st["pending_deleverage"]);

    // the worker's reason log marks these receipts as automatic (drives the ⚡ tag / "while you were away")
    let client = reqwest_like::Client::new(port, TOKEN);
    let reasons = client.get(&format!("/vaults/{vault}/reasons")).await?;
    let auto: Vec<&str> = reasons["reasons"]
        .as_array()
        .expect("reasons array")
        .iter()
        .filter(|r| r["source"] == "auto_protection")
        .filter_map(|r| r["hash"].as_str())
        .collect();
    let auto_receipts = receipts.as_array().unwrap().iter().filter(|r| r["reason_hash"].as_str().is_some_and(|h| auto.contains(&h))).count();
    println!("reasons: {} automatic, matching {auto_receipts} receipts", auto.len());
    assert!(auto_receipts >= 3, "withdraw/swap/repay receipts must map to automatic reasons: {reasons}");

    // owner-approved plan over the HTTP API: supply 1 wNEAR
    client.post("/vaults", json!({ "vaultId": vault, "owner": env.alice.id() })).await?;
    let r = client
        .post("/plans", json!({ "planId": "plan-1", "vaultId": vault, "owner": env.alice.id(), "reasoning": "e2e",
            "steps": [{ "method": "agent_supply", "args": { "token": WNEAR, "amount": E24.to_string() }, "label": "Supply 1 wNEAR" }] }))
        .await?;
    assert_eq!(r["planId"], "plan-1", "{r}");
    let bad = client.post("/plans", json!({ "planId": "plan-2", "vaultId": vault, "owner": "mallory.test.near", "steps": [] })).await?;
    assert!(bad["error"].is_string(), "owner mismatch / empty plan must be rejected: {bad}");
    let start = Instant::now();
    let mut status = Value::Null;
    while start.elapsed() < Duration::from_secs(60) {
        tokio::time::sleep(Duration::from_secs(3)).await;
        status = client.get("/plans/plan-1").await?;
        if status["status"] == "done" || status["status"] == "failed" {
            break;
        }
    }
    println!("plan: {status}");
    assert_eq!(status["status"], "done");

    // Optional: keep the sandbox + worker running to look at the web app against them, e.g.
    // TRELLIS_DEMO_HOLD_SECS=900 cargo test -p integration-tests --test worker_e2e -- --nocapture
    if let Some(secs) = std::env::var("TRELLIS_DEMO_HOLD_SECS").ok().and_then(|s| s.parse::<u64>().ok()) {
        println!("DEMO rpc={} worker=http://127.0.0.1:{port} token={TOKEN} vault={vault}", env.worker.rpc_addr());
        tokio::time::sleep(Duration::from_secs(secs)).await;
    }
    Ok(())
}

/// Minimal HTTP client over std (no extra deps).
mod reqwest_like {
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    pub struct Client {
        port: u16,
        token: String,
    }
    impl Client {
        pub fn new(port: u16, token: &str) -> Self {
            Self { port, token: token.to_string() }
        }
        fn req(&self, method: &str, path: &str, body: Option<Value>) -> anyhow::Result<Value> {
            let mut s = TcpStream::connect(("127.0.0.1", self.port))?;
            let b = body.map(|v| v.to_string()).unwrap_or_default();
            write!(
                s,
                "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",
                self.token,
                b.len()
            )?;
            let mut resp = String::new();
            s.read_to_string(&mut resp)?;
            let json = resp.split("\r\n\r\n").nth(1).unwrap_or("null");
            Ok(serde_json::from_str(json).unwrap_or(Value::Null))
        }
        pub async fn post(&self, path: &str, body: Value) -> anyhow::Result<Value> {
            self.req("POST", path, Some(body))
        }
        pub async fn get(&self, path: &str) -> anyhow::Result<Value> {
            self.req("GET", path, None)
        }
    }
}

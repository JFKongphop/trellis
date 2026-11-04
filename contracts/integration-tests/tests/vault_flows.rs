//! End-to-end vault tests against real mainnet wrap.near / Ref v2 / Burrow wasm in a local sandbox.
//! Build first: `cargo near build non-reproducible-wasm` in vault/ and mock-oracle/.
mod common;

use common::*;
use serde_json::json;

/// Supply → borrow → sync → swap → repay, with receipts and health factor.
#[tokio::test]
async fn happy_path_supply_borrow_swap_repay() -> anyhow::Result<()> {
    let env = Env::new().await?;
    env.configure().await?;
    let vault = env.vault.id().clone();

    // supply 20 wNEAR as collateral
    let r = env.agent("agent_supply", json!({ "token": WNEAR, "amount": (20 * E24).to_string(), "reason_hash": "h1" })).await?;
    assert_eq!(report("supply 20 wNEAR", &r), 0);
    assert!(has_event(&r, "action_settled"));
    assert_eq!(collateral_balance(&env.positions().await?, WNEAR), 20 * E24);
    println!("supply total gas: {:.1} Tgas", total_tgas(&r));

    // borrow 20 USDC: HF = (100 × 0.75) / (20 / 0.95) ≈ 3.56 ≥ 1.5
    let usdc_before = env.balance(USDC, &vault).await?;
    let r = env.agent("agent_borrow", json!({ "token": USDC, "amount": "20000000", "reason_hash": "h2" })).await?;
    assert_eq!(report("borrow 20 USDC", &r), 0);
    assert!(has_event(&r, "action_submitted"), "borrow should be submitted, awaiting sync");
    println!("borrow total gas: {:.1} Tgas", total_tgas(&r));

    // sync too early is rejected
    let early = env.agent("sync_position", json!({})).await?;
    assert!(early.is_failure(), "sync before MIN_SYNC_DELAY must fail");

    env.wait_for_sync("500000000").await?;
    let r = env.agent("sync_position", json!({})).await?;
    assert_eq!(report("sync after borrow", &r), 0);
    let settled = event_data(&r, "action_settled").expect("borrow settled");
    println!("settled: {settled}");
    let received = env.balance(USDC, &vault).await? - usdc_before;
    assert!(received >= 19_999_999, "vault received {received}");
    let status = env.status().await?;
    let hf: u64 = status["last_health"]["health_factor_bps"].as_str().unwrap().parse()?;
    println!("health factor after borrow: {hf} bps");
    assert!((35_000..36_000).contains(&hf), "expected ~3.56, got {hf}");

    // swap 2 USDC → wNEAR through the allowlisted pool (sandbox pool is only 500 USDC deep:
    // 10 USDC would move the price ~2.3% and the vault's 2% slippage limit would reject it)
    let wnear_before = env.balance(WNEAR, &vault).await?;
    let r = env
        .agent("agent_swap_ref", json!({ "pool_id": env.pool_id, "token_in": USDC, "token_out": WNEAR, "amount_in": "2000000", "reason_hash": "h3" }))
        .await?;
    assert_eq!(report("swap 2 USDC → wNEAR", &r), 0);
    let settled = event_data(&r, "action_settled").expect("swap settled");
    println!("swap settled: {settled}");
    let got = env.balance(WNEAR, &vault).await? - wnear_before;
    assert!(got > 39 * E24 / 100, "got {got} yocto wNEAR (~0.4 expected)");
    println!("swap total gas: {:.1} Tgas", total_tgas(&r));

    // repay 5 USDC
    let r = env.agent("agent_repay", json!({ "token": USDC, "amount": "5000000", "reason_hash": "h4" })).await?;
    assert_eq!(report("repay 5 USDC", &r), 0);
    assert!(has_event(&r, "action_settled"));

    let receipts: serde_json::Value = env.vault.view("get_receipts").args_json(json!({})).await?.json()?;
    let kinds: Vec<_> = receipts.as_array().unwrap().iter().map(|r| format!("{}:{}", r["kind"], r["status"])).collect();
    println!("receipts (newest first): {kinds:?}");
    assert_eq!(kinds.len(), 4);
    assert!(env.status().await?["in_flight"].is_null());
    Ok(())
}

/// Borrow that would push HF below the policy minimum (1.5) is rejected by the vault, not Burrow.
#[tokio::test]
async fn rejects_borrow_below_min_health_factor() -> anyhow::Result<()> {
    let env = Env::new().await?;
    env.configure().await?;
    env.agent("agent_supply", json!({ "token": WNEAR, "amount": (20 * E24).to_string(), "reason_hash": "s" })).await?.into_result()?;
    // max debt at HF 1.5: 75 / 1.5 × 0.95 = 47.5 USDC → 60 USDC must be rejected
    let r = env.agent("agent_borrow", json!({ "token": USDC, "amount": "60000000", "reason_hash": "b" })).await?;
    report("borrow 60 USDC (HF < 1.5)", &r);
    let v = event_data(&r, "policy_violation").expect("policy_violation event");
    println!("violation: {v}");
    assert_eq!(v["rule"], "min_health_factor");
    assert_eq!(debt_shares(&env.positions().await?, USDC), 0, "no debt may be created");
    assert!(env.status().await?["in_flight"].is_null(), "lock released");
    Ok(())
}

/// Stale oracle price → the vault refuses to borrow.
#[tokio::test]
async fn rejects_stale_price() -> anyhow::Result<()> {
    let env = Env::new().await?;
    env.configure().await?;
    env.agent("agent_supply", json!({ "token": WNEAR, "amount": (20 * E24).to_string(), "reason_hash": "s" })).await?.into_result()?;
    env.set_prices("500000000", -120).await?;
    let r = env.agent("agent_borrow", json!({ "token": USDC, "amount": "5000000", "reason_hash": "b" })).await?;
    report("borrow with stale price", &r);
    let failed = event_data(&r, "action_failed").expect("action_failed");
    println!("failed: {failed}");
    assert_eq!(failed[0]["note"], "price_missing", "mock oracle returns null for prices older than age");
    assert_eq!(debt_shares(&env.positions().await?, USDC), 0);
    Ok(())
}

/// An allowlisted pool id whose token pair isn't (token_in, token_out) is rejected (fake-pool attack).
#[tokio::test]
async fn rejects_wrong_pair_pool() -> anyhow::Result<()> {
    let env = Env::new().await?;
    env.configure().await?;
    let vault = env.vault.id().clone();
    let before = env.balance(WNEAR, &vault).await?;
    let remaining_before: String = env.vault.view("remaining_daily").args_json(json!({ "token": WNEAR })).await?.json()?;
    let r = env
        .agent("agent_swap_ref", json!({ "pool_id": env.fake_pool_id, "token_in": WNEAR, "token_out": USDC, "amount_in": E24.to_string(), "reason_hash": "x" }))
        .await?;
    report("swap through wNEAR/FAKE pool", &r);
    assert_eq!(event_data(&r, "policy_violation").unwrap()["rule"], "pool_token_pair");
    assert_eq!(env.balance(WNEAR, &vault).await?, before, "nothing left the vault");
    let remaining_after: String = env.vault.view("remaining_daily").args_json(json!({ "token": WNEAR })).await?.json()?;
    assert_eq!(remaining_before, remaining_after, "cap reservation released");
    Ok(())
}

/// Pool price far from the oracle → Ref rejects min_out → input is refunded, cap released.
#[tokio::test]
async fn swap_slippage_refunds() -> anyhow::Result<()> {
    let env = Env::new().await?;
    env.configure().await?;
    let vault = env.vault.id().clone();
    env.set_prices("600000000", 0).await?; // oracle says $6, pool trades at ~$5
    let before = env.balance(WNEAR, &vault).await?;
    let r = env
        .agent("agent_swap_ref", json!({ "pool_id": env.pool_id, "token_in": WNEAR, "token_out": USDC, "amount_in": E24.to_string(), "reason_hash": "x" }))
        .await?;
    report("swap with pool 17% below oracle", &r);
    let failed = event_data(&r, "action_failed").expect("action_failed");
    println!("failed: {failed}");
    assert_eq!(failed[0]["note"], "swap_failed_refunded");
    assert_eq!(env.balance(WNEAR, &vault).await?, before, "wNEAR returned to the vault");
    let rem: String = env.vault.view("remaining_daily").args_json(json!({ "token": WNEAR })).await?.json()?;
    assert_eq!(rem, (50 * E24).to_string(), "reservation released");
    Ok(())
}

/// Who can call what.
#[tokio::test]
async fn access_control() -> anyhow::Result<()> {
    let env = Env::new().await?;
    env.configure().await?;
    let vault = env.vault.id().clone();

    // a stranger can't act as the agent
    let r = env.mallory.call(&vault, "agent_supply")
        .args_json(json!({ "token": WNEAR, "amount": E24.to_string(), "reason_hash": "x" })).transact().await?;
    assert!(r.is_failure(), "stranger agent call must fail");

    // the agent can't call owner methods (even with 1 yocto) or withdraw
    let r = env.agent.call(&vault, "withdraw_ft")
        .args_json(json!({ "token": WNEAR, "amount": E24.to_string() })).deposit(ONE_YOCTO).transact().await?;
    assert!(r.is_failure(), "agent withdraw must fail");

    // callbacks are private
    let r = env.agent.call(&vault, "on_transfer_call_done").args_json(json!({ "op_id": 1 })).transact().await?;
    assert!(r.is_failure(), "private callback must fail");

    // agent methods reject attached deposits
    let r = env.agent.call(&vault, "agent_supply")
        .args_json(json!({ "token": WNEAR, "amount": E24.to_string(), "reason_hash": "x" }))
        .deposit(ONE_YOCTO).transact().await?;
    assert!(r.is_failure(), "agent methods are non-payable");

    // pause blocks the agent; owner can still withdraw while paused
    env.owner("pause", json!({})).await?.into_result()?;
    let r = env.agent("agent_supply", json!({ "token": WNEAR, "amount": E24.to_string(), "reason_hash": "x" })).await?;
    assert!(r.is_failure(), "paused vault blocks the agent");
    let alice_before = env.balance(WNEAR, env.alice.id()).await?;
    let r = env.owner("withdraw_ft", json!({ "token": WNEAR, "amount": (5 * E24).to_string() })).await?;
    assert_eq!(report("owner withdraw while paused", &r), 0);
    assert_eq!(env.balance(WNEAR, env.alice.id()).await? - alice_before, 5 * E24);

    // revoke → agent can't act even after unpause
    env.owner("unpause", json!({})).await?.into_result()?;
    env.owner("revoke_agent", json!({})).await?.into_result()?;
    let r = env.agent("agent_supply", json!({ "token": WNEAR, "amount": E24.to_string(), "reason_hash": "x" })).await?;
    assert!(r.is_failure(), "revoked agent blocked");
    Ok(())
}

/// Withdraw collateral within limits works; deleverage mode is refused while HF is healthy.
#[tokio::test]
async fn withdraw_collateral_and_deleverage_guard() -> anyhow::Result<()> {
    let env = Env::new().await?;
    env.configure().await?;
    let vault = env.vault.id().clone();
    env.agent("agent_supply", json!({ "token": WNEAR, "amount": (20 * E24).to_string(), "reason_hash": "s" })).await?.into_result()?;
    env.agent("agent_borrow", json!({ "token": USDC, "amount": "20000000", "reason_hash": "b" })).await?.into_result()?;
    env.wait_for_sync("500000000").await?;
    env.agent("sync_position", json!({})).await?.into_result()?;

    // deleverage=true while HF ≈ 3.56 > trigger 1.3 → refused
    let r = env.agent("agent_withdraw_collateral", json!({ "token": WNEAR, "amount": E24.to_string(), "deleverage": true, "reason_hash": "d" })).await?;
    report("deleverage while healthy", &r);
    assert_eq!(event_data(&r, "policy_violation").unwrap()["rule"], "deleverage_not_needed");

    // normal withdraw of 5 wNEAR: HF → (75 × 15/20) / 21.05 ≈ 2.67 ≥ 1.5 → allowed
    let before = env.balance(WNEAR, &vault).await?;
    let r = env.agent("agent_withdraw_collateral", json!({ "token": WNEAR, "amount": (5 * E24).to_string(), "deleverage": false, "reason_hash": "w" })).await?;
    assert_eq!(report("withdraw 5 wNEAR collateral", &r), 0);
    env.wait_for_sync("500000000").await?;
    let r = env.agent("sync_position", json!({})).await?;
    assert_eq!(report("sync after withdraw", &r), 0);
    assert!(has_event(&r, "action_settled"));
    assert!(env.balance(WNEAR, &vault).await? - before >= 5 * E24 - 1);

    // price crash: NEAR $5 → $2.40: HF = (15×2.4×0.75)/21.05 ≈ 1.28 < trigger 1.3 → deleverage allowed;
    // withdrawing 1 wNEAR leaves HF ≈ 1.20 ≥ floor 1.1
    env.set_prices("240000000", 0).await?;
    let r = env.agent("agent_withdraw_collateral", json!({ "token": WNEAR, "amount": E24.to_string(), "deleverage": true, "reason_hash": "d2" })).await?;
    report("deleverage after crash", &r);
    assert!(has_event(&r, "action_submitted"), "deleverage allowed below trigger");
    Ok(())
}

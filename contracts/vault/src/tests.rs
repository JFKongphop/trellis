use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};

use super::*;

const DAY_NS: u64 = 86_400_000_000_000;
const QUOTE: &str = include_str!("../testdata/1click_dry_quote.json");
const QUOTE_SIG: &str = "ed25519:nrEjMvMjZcpQn5iqFhWBw5utCFr7eDGTKJ1ynRdK3cUs2vXtDnszU9SJKfHF9AnQ6KWJKZxNQbiMT5p8c5ucrar";
const ONE_CLICK_KEY: &str = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("alice.near")
}
fn agent() -> AccountId {
    acc("agent.trellis.near")
}
fn vault_id() -> AccountId {
    acc("v1.trellis.near")
}
fn wnear() -> AccountId {
    acc("wrap.near")
}
fn usdc() -> AccountId {
    acc("usdc.near")
}

fn ctx(predecessor: AccountId, deposit: u128, ts: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault_id())
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(10))
        .block_timestamp(ts);
    b
}

fn set(predecessor: AccountId, deposit: u128, ts: u64) {
    testing_env!(ctx(predecessor, deposit, ts).build());
}

fn policy() -> Policy {
    Policy {
        allowed_tokens: vec![wnear(), usdc()],
        allowed_ref_pools: vec![4512],
        per_action_cap: vec![(wnear(), U128(10 * 10u128.pow(24))), (usdc(), U128(100_000_000))],
        daily_cap: vec![(wnear(), U128(20 * 10u128.pow(24))), (usdc(), U128(200_000_000))],
        burrow_enabled: true,
        ref_enabled: true,
        ..Policy::default()
    }
}

/// Vault with a policy, an agent and two registered tokens (registration bypassed for unit tests).
fn setup() -> Vault {
    set(acc("trellis.near"), 0, DAY_NS);
    let mut v = Vault::new(owner(), None);
    set(owner(), 1, DAY_NS);
    v.set_policy(policy());
    v.set_agent(agent(), None);
    for (t, dec, extra, vol) in [(wnear(), 24, 0, 7_500), (usdc(), 6, 12, 9_500)] {
        v.tokens.insert(t, TokenInfo { decimals: dec, burrow_extra_decimals: extra, price_id: "a".repeat(64), volatility_ratio_bps: vol });
    }
    v
}

#[test]
fn init_defaults() {
    set(acc("trellis.near"), 0, 0);
    let v = Vault::new(owner(), None);
    assert_eq!(v.get_owner(), owner());
    assert_eq!(v.get_protocols(), Protocols::mainnet());
    let p = v.get_policy();
    assert!(p.allowed_tokens.is_empty() && !p.burrow_enabled && !p.ref_enabled && !p.intents_enabled);
    assert!(v.get_status().agent.is_none());
}

#[test]
#[should_panic(expected = "Owner can't be the vault itself")]
fn init_rejects_self_owner() {
    set(acc("trellis.near"), 0, 0);
    Vault::new(vault_id(), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_methods_need_one_yocto() {
    let mut v = setup();
    set(owner(), 0, DAY_NS);
    v.pause();
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn agent_cannot_call_owner_methods() {
    let mut v = setup();
    set(agent(), 1, DAY_NS);
    v.set_policy(policy());
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn agent_cannot_withdraw() {
    let mut v = setup();
    set(agent(), 1, DAY_NS);
    let _ = v.withdraw_ft(usdc(), U128(1));
}

#[test]
fn policy_validation() {
    let ok = policy();
    assert!(ok.validate().is_ok());
    let mut p = ok.clone();
    p.min_health_factor_bps = 10_500;
    assert!(p.validate().is_err(), "HF floor below 1.1 must be rejected");
    let mut p = ok.clone();
    p.max_slippage_bps = 1_000;
    assert!(p.validate().is_err(), "10% slippage must be rejected");
    let mut p = ok.clone();
    p.daily_cap.push((acc("evil.near"), U128(1)));
    assert!(p.validate().is_err(), "cap on a token that isn't allowed");
    let mut p = ok.clone();
    p.per_action_cap[0].1 = U128(30 * 10u128.pow(24));
    assert!(p.validate().is_err(), "per-action cap above daily cap");
    let mut p = ok.clone();
    p.deleverage_trigger_bps = p.emergency_floor_bps;
    assert!(p.validate().is_err(), "trigger must be above the floor");
    let mut p = ok.clone();
    p.intents_quote_pubkey = Some("not-a-key".into());
    assert!(p.validate().is_err());
    let mut p = ok;
    p.intents_quote_pubkey = Some(ONE_CLICK_KEY.into());
    assert!(p.validate().is_ok());
}

#[test]
#[should_panic(expected = "ERR_INVALID_POLICY")]
fn set_policy_rejects_invalid() {
    let mut v = setup();
    let mut p = policy();
    p.max_slippage_bps = 0;
    set(owner(), 1, DAY_NS);
    v.set_policy(p);
}

#[test]
#[should_panic(expected = "ERR_NOT_AGENT")]
fn stranger_cannot_act() {
    let mut v = setup();
    set(acc("mallory.near"), 0, DAY_NS);
    let _ = v.agent_supply(usdc(), U128(1_000_000), "r".into());
}

#[test]
#[should_panic(expected = "ERR_NOT_AGENT")]
fn revoked_agent_cannot_act() {
    let mut v = setup();
    set(owner(), 1, DAY_NS);
    v.revoke_agent();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_supply(usdc(), U128(1_000_000), "r".into());
}

#[test]
#[should_panic(expected = "ERR_NOT_AGENT")]
fn expired_agent_cannot_act() {
    let mut v = setup();
    set(owner(), 1, DAY_NS);
    v.set_agent(agent(), Some(U64(DAY_NS + 1_000)));
    set(agent(), 0, DAY_NS + 1_000);
    let _ = v.agent_supply(usdc(), U128(1_000_000), "r".into());
}

#[test]
#[should_panic(expected = "ERR_PAUSED")]
fn paused_blocks_agent() {
    let mut v = setup();
    set(owner(), 1, DAY_NS);
    v.pause();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_supply(usdc(), U128(1_000_000), "r".into());
}

#[test]
#[should_panic(expected = "ERR_TOKEN_NOT_ALLOWED")]
fn token_must_be_allowed() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_supply(acc("usdt.tether-token.near"), U128(1), "r".into());
}

#[test]
#[should_panic(expected = "ERR_PER_ACTION_CAP")]
fn per_action_cap() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_supply(usdc(), U128(100_000_001), "r".into());
}

#[test]
fn daily_cap_reserves_and_rolls_over() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_supply(usdc(), U128(100_000_000), "r".into());
    assert!(v.in_flight.is_some());
    assert_eq!(v.remaining_daily(usdc()), U128(100_000_000));
    // the lock blocks a second action
    v.in_flight = None;
    let _ = v.agent_supply(usdc(), U128(100_000_000), "r".into());
    assert_eq!(v.remaining_daily(usdc()), U128(0));
    v.in_flight = None;
    // over the daily cap → panics
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = v.agent_supply(usdc(), U128(1), "r".into());
    }));
    assert!(r.is_err());
    // next day: fresh cap
    set(agent(), 0, 2 * DAY_NS);
    let mut v2 = v;
    v2.in_flight = None;
    assert_eq!(v2.remaining_daily(usdc()), U128(200_000_000));
}

#[test]
#[should_panic(expected = "ERR_OP_IN_FLIGHT")]
fn one_op_at_a_time() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_supply(usdc(), U128(1_000_000), "r".into());
    let _ = v.agent_repay(usdc(), U128(1_000_000), "r".into());
}

#[test]
#[should_panic(expected = "ERR_POOL_NOT_ALLOWED")]
fn swap_pool_must_be_allowed() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_swap_ref(1, wnear(), usdc(), U128(10u128.pow(24)), "r".into());
}

#[test]
fn failed_settlement_releases_reservation() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_supply(usdc(), U128(50_000_000), "r".into());
    assert_eq!(v.remaining_daily(usdc()), U128(150_000_000));
    let op_id = v.in_flight.as_ref().unwrap().op_id.0;
    v.finish_op(op_id, ReceiptStatus::Failed, 0, 50_000_000, None, "not_accepted");
    assert_eq!(v.remaining_daily(usdc()), U128(200_000_000));
    assert!(v.in_flight.is_none());
    let r = v.get_receipts(None, None);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].status, ReceiptStatus::Failed);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"action_failed\"")));
}

#[test]
fn ft_on_transfer_accepts_only_registered_tokens() {
    let mut v = setup();
    set(usdc(), 0, DAY_NS);
    match v.ft_on_transfer(owner(), U128(5), String::new()) {
        PromiseOrValue::Value(r) => assert_eq!(r, U128(0)),
        _ => panic!(),
    }
    set(acc("scam-token.near"), 0, DAY_NS);
    match v.ft_on_transfer(owner(), U128(5), String::new()) {
        PromiseOrValue::Value(r) => assert_eq!(r, U128(5), "unknown tokens are refunded"),
        _ => panic!(),
    }
}

#[test]
fn receipts_ring_buffer_newest_first() {
    let mut v = setup();
    for i in 0..(MAX_RECEIPTS + 7) {
        set(agent(), 0, DAY_NS + i as u64);
        let _ = v.agent_repay(usdc(), U128(1 + i as u128), "r".into());
        let op_id = v.in_flight.as_ref().unwrap().op_id.0;
        v.finish_op(op_id, ReceiptStatus::Settled, 0, 0, None, "");
    }
    let r = v.get_receipts(None, None);
    assert_eq!(r.len(), MAX_RECEIPTS as usize);
    assert_eq!(r[0].amount_in, U128((MAX_RECEIPTS + 7) as u128), "newest first");
    assert_eq!(r.last().unwrap().amount_in, U128(8), "oldest kept is #8");
    let page = v.get_receipts(Some(1), Some(2));
    assert_eq!(page[0].amount_in, U128((MAX_RECEIPTS + 6) as u128));
}

#[test]
#[should_panic(expected = "ERR_LOCK_NOT_STALE")]
fn clear_lock_only_when_stale() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_supply(usdc(), U128(1_000_000), "r".into());
    let op = v.in_flight.as_ref().unwrap().op_id;
    set(owner(), 1, DAY_NS + 60_000_000_000);
    v.clear_stale_lock(op);
}

#[test]
fn clear_stale_lock_releases_op_that_sent_nothing() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    // swap: the cap is reserved, but nothing leaves the vault until the precheck callback
    let _ = v.agent_swap_ref(4512, usdc(), wnear(), U128(1_000_000), "r".into());
    let op = v.in_flight.as_ref().unwrap().op_id;
    set(owner(), 1, DAY_NS + STALE_LOCK_NS);
    v.clear_stale_lock(op);
    assert!(v.in_flight.is_none());
    set(owner(), 0, DAY_NS + STALE_LOCK_NS);
    assert_eq!(v.remaining_daily(usdc()), U128(200_000_000));
}

#[test]
fn clear_stale_lock_keeps_reservation_once_funds_left() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    // supply fires ft_transfer_call in the same call: the funds may already be gone
    let _ = v.agent_supply(usdc(), U128(1_000_000), "r".into());
    assert!(v.in_flight.as_ref().unwrap().funds_sent);
    let op = v.in_flight.as_ref().unwrap().op_id;
    set(owner(), 1, DAY_NS + STALE_LOCK_NS);
    v.clear_stale_lock(op);
    set(owner(), 0, DAY_NS + STALE_LOCK_NS);
    assert_eq!(v.remaining_daily(usdc()), U128(199_000_000));
}

#[test]
fn near_reserve_is_kept() {
    let mut v = setup();
    // balance 10 NEAR, reserve 0.5 NEAR: wrapping 9.6 NEAR must fail, 5 NEAR is fine
    set(agent(), 0, DAY_NS);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = v.agent_wrap_near(U128(NearToken::from_millinear(9_600).as_yoctonear()), "r".into());
    }));
    assert!(r.is_err());
    let _ = v.agent_wrap_near(U128(NearToken::from_near(5).as_yoctonear()), "r".into());
    assert!(v.in_flight.is_some());
}

// ---------------- 1Click quote verification (real signed quote, 2026-10-21) ----------------

#[test]
fn one_click_signature_verifies() {
    set(owner(), 0, 0);
    assert!(intents::verify_quote_signature(QUOTE, QUOTE_SIG, ONE_CLICK_KEY));
}

#[test]
fn one_click_signature_rejects_tampering() {
    set(owner(), 0, 0);
    let tampered = QUOTE.replace("sprout-demo.near", "attacker.near");
    assert!(!intents::verify_quote_signature(&tampered, QUOTE_SIG, ONE_CLICK_KEY));
    let tampered = QUOTE.replace("\"slippageTolerance\":100", "\"slippageTolerance\":500");
    assert!(!intents::verify_quote_signature(&tampered, QUOTE_SIG, ONE_CLICK_KEY));
    assert!(!intents::verify_quote_signature(QUOTE, QUOTE_SIG, "ed25519:11111111111111111111111111111111"));
}

#[test]
fn one_click_quote_structure_checks() {
    let q: intents::SignedQuote = near_sdk::serde_json::from_str(QUOTE).unwrap();
    // the real quote is a dry quote for sprout-demo.near → rejected
    assert_eq!(intents::check_vault_quote(&q, &acc("sprout-demo.near"), 0), Err("dry quote"));
    assert_eq!(intents::parse_iso8601_utc_ns("2026-10-21T18:10:18.355Z"), Some(1_792_606_218_355_000_000));
}

#[test]
#[should_panic(expected = "ERR_INTENTS_DISABLED")]
fn intents_route_needs_enabled() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_route_intents(QUOTE.into(), QUOTE_SIG.into(), "r".into());
}

#[test]
#[should_panic(expected = "ERR_QUOTE: dry quote")]
fn intents_route_rejects_dry_quote_after_signature() {
    let mut v = setup();
    let mut p = policy();
    p.intents_enabled = true;
    p.intents_quote_pubkey = Some(ONE_CLICK_KEY.into());
    set(owner(), 1, DAY_NS);
    v.set_policy(p);
    set(agent(), 0, DAY_NS);
    let _ = v.agent_route_intents(QUOTE.into(), QUOTE_SIG.into(), "r".into());
}

#[test]
#[should_panic(expected = "ERR_BAD_QUOTE_SIGNATURE")]
fn intents_route_rejects_forged_quote() {
    let mut v = setup();
    let mut p = policy();
    p.intents_enabled = true;
    p.intents_quote_pubkey = Some(ONE_CLICK_KEY.into());
    set(owner(), 1, DAY_NS);
    v.set_policy(p);
    set(agent(), 0, DAY_NS);
    let forged = QUOTE.replace("sprout-demo.near", "attacker.near");
    let _ = v.agent_route_intents(forged, QUOTE_SIG.into(), "r".into());
}

// ---------------- security review fixes (2026-10-22) ----------------

use near_sdk::PromiseResult;

/// Callback context: called by the vault itself at `ts` with the given promise results.
fn cb(ts: u64, results: Vec<PromiseResult>) {
    testing_env!(
        ctx(vault_id(), 0, ts).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}
fn ok(s: &str) -> PromiseResult {
    PromiseResult::Successful(s.as_bytes().to_vec())
}
fn positions(collateral: &str, borrowed: &str) -> PromiseResult {
    ok(&format!(r#"{{"account_id":"v1.trellis.near","positions":{{"REGULAR":{{"collateral":[{collateral}],"borrowed":[{borrowed}]}}}},"supplied":[]}}"#))
}
fn price_json(price: &str, ts_ns: u64) -> PromiseResult {
    ok(&format!(r#"{{"price":"{price}","conf":"10000","expo":-8,"publish_time":{}}}"#, ts_ns / 1_000_000_000))
}
fn op_id(v: &Vault) -> u64 {
    v.in_flight.as_ref().unwrap().op_id.0
}
fn last_note(v: &Vault) -> String {
    v.get_receipts(None, Some(1))[0].note.clone()
}

// Finding 3: "no effect yet" isn't final until SYNC_FINAL_NS, so borrows can't be stacked.
#[test]
fn borrow_sync_stays_pending_until_final() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_borrow(usdc(), U128(10_000_000), "r".into());
    let id = op_id(&v);
    {
        let o = v.op_mut(id).unwrap();
        o.state = OpState::Submitted;
        o.submitted_at = Some(U64(DAY_NS));
        o.shares_before = Some(U128(0));
        o.balance_before = Some(U128(0));
    }
    // 10 s later Burrow still shows no borrow: keep waiting, lock stays
    cb(DAY_NS + 10_000_000_000, vec![positions("", ""), ok("\"0\"")]);
    v.on_sync(Some(U64(id)), true, vec![]);
    assert!(v.in_flight.is_some(), "must not finish early");
    set(agent(), 0, DAY_NS + 11_000_000_000);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = v.agent_borrow(usdc(), U128(10_000_000), "r".into());
    }));
    assert!(r.is_err(), "second borrow blocked while the first may still land");
    // after the final window: declared not executed
    cb(DAY_NS + SYNC_FINAL_NS, vec![positions("", ""), ok("\"0\"")]);
    v.on_sync(Some(U64(id)), true, vec![]);
    assert!(v.in_flight.is_none());
    assert_eq!(last_note(&v), "borrow_not_executed");
}

#[test]
fn borrow_sync_settles_as_soon_as_visible() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_borrow(usdc(), U128(10_000_000), "r".into());
    let id = op_id(&v);
    {
        let o = v.op_mut(id).unwrap();
        o.state = OpState::Submitted;
        o.submitted_at = Some(U64(DAY_NS));
        o.shares_before = Some(U128(0));
        o.balance_before = Some(U128(0));
    }
    let debt = r#"{"token_id":"usdc.near","balance":"10000000000000000000","shares":"10000000000000000000"}"#;
    cb(DAY_NS + 6_000_000_000, vec![positions("", debt), ok("\"10000000\"")]);
    v.on_sync(Some(U64(id)), true, vec![]);
    assert!(v.in_flight.is_none());
    assert_eq!(v.get_receipts(None, Some(1))[0].status, ReceiptStatus::Settled);
}

// Finding 4: after a deleverage withdrawal the agent must swap + repay before anything else.
fn vault_after_deleverage_withdraw() -> Vault {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_withdraw_collateral(wnear(), U128(5 * 10u128.pow(24)), true, "r".into());
    let id = op_id(&v);
    {
        let o = v.op_mut(id).unwrap();
        o.state = OpState::Submitted;
        o.submitted_at = Some(U64(DAY_NS));
        o.shares_before = Some(U128(20 * 10u128.pow(24)));
        o.balance_before = Some(U128(0));
        o.amount_in = U128(5 * 10u128.pow(24));
    }
    let coll = r#"{"token_id":"wrap.near","balance":"15000000000000000000000000","shares":"15000000000000000000000000"}"#;
    cb(DAY_NS + 6_000_000_000, vec![positions(coll, ""), ok("\"5000000000000000000000000\"")]);
    v.on_sync(Some(U64(id)), true, vec![]);
    assert!(v.in_flight.is_none());
    v
}

#[test]
fn deleverage_withdraw_opens_a_cycle() {
    let v = vault_after_deleverage_withdraw();
    let d = v.get_status().pending_deleverage.expect("cycle open");
    assert_eq!(d.collateral_token, wnear());
    assert_eq!(d.collateral_left, U128(5 * 10u128.pow(24)));
    assert_eq!(d.repay_due, U128(0));
}

#[test]
#[should_panic(expected = "ERR_DELEVERAGE_PENDING")]
fn deleverage_cycle_blocks_borrow() {
    let mut v = vault_after_deleverage_withdraw();
    set(agent(), 0, DAY_NS + 7_000_000_000);
    let _ = v.agent_borrow(usdc(), U128(1_000_000), "r".into());
}

#[test]
#[should_panic(expected = "ERR_DELEVERAGE_PENDING")]
fn deleverage_cycle_blocks_second_withdraw() {
    let mut v = vault_after_deleverage_withdraw();
    set(agent(), 0, DAY_NS + 7_000_000_000);
    let _ = v.agent_withdraw_collateral(wnear(), U128(10u128.pow(24)), true, "r".into());
}

#[test]
#[should_panic(expected = "ERR_DELEVERAGE_PENDING")]
fn deleverage_cycle_blocks_other_swaps() {
    let mut v = vault_after_deleverage_withdraw();
    set(agent(), 0, DAY_NS + 7_000_000_000);
    let _ = v.agent_swap_ref(4512, usdc(), wnear(), U128(1_000_000), "r".into());
}

#[test]
fn deleverage_cycle_closes_after_swap_and_repay() {
    let mut v = vault_after_deleverage_withdraw();
    let t = DAY_NS + 7_000_000_000;
    // swap the withdrawn wNEAR into USDC (allowed)
    set(agent(), 0, t);
    let _ = v.agent_swap_ref(4512, wnear(), usdc(), U128(5 * 10u128.pow(24)), "r".into());
    let id = op_id(&v);
    cb(t, vec![ok("\"12000000\"")]); // Ref withdraw returned the amount
    v.on_ref_withdrawn(id, true, U128(12_000_000));
    let d = v.get_status().pending_deleverage.unwrap();
    assert_eq!(d.collateral_left, U128(0));
    assert_eq!(d.debt_token, Some(usdc()));
    assert_eq!(d.repay_due, U128(12_000_000));
    // a 1-unit repay doesn't close it
    set(agent(), 0, t);
    let _ = v.agent_repay(usdc(), U128(1), "r".into());
    let id = op_id(&v);
    let debt = r#"{"token_id":"usdc.near","balance":"20000000000000000000","shares":"20000000000000000000"}"#;
    cb(t, vec![positions("", debt)]);
    let _ = v.on_repay_precheck(id);
    cb(t, vec![ok("\"1\"")]);
    v.on_transfer_call_done(id, Some(U128(20_000_001)));
    assert!(v.get_status().pending_deleverage.is_some());
    // repaying the proceeds does
    set(agent(), 0, t);
    let _ = v.agent_repay(usdc(), U128(11_999_999), "r".into());
    let id = op_id(&v);
    cb(t, vec![positions("", debt)]);
    let _ = v.on_repay_precheck(id);
    cb(t, vec![ok("\"11999999\"")]);
    v.on_transfer_call_done(id, Some(U128(20_000_001)));
    assert!(v.get_status().pending_deleverage.is_none());
}

#[test]
fn owner_can_clear_deleverage() {
    let mut v = vault_after_deleverage_withdraw();
    set(owner(), 1, DAY_NS + 7_000_000_000);
    v.clear_deleverage();
    assert!(v.get_status().pending_deleverage.is_none());
}

#[test]
fn policy_needs_gap_between_trigger_and_min() {
    let mut p = policy();
    p.deleverage_trigger_bps = p.min_health_factor_bps; // the review's "trigger == min" setup
    assert!(p.validate().is_err());
    p.deleverage_trigger_bps = p.min_health_factor_bps - 499;
    assert!(p.validate().is_err());
    p.deleverage_trigger_bps = p.min_health_factor_bps - 500;
    assert!(p.validate().is_ok());
    let mut p = policy();
    p.max_intents_spread_bps = p.max_slippage_bps + 1;
    assert!(p.validate().is_err());
}

// Finding 8: repay sends at most the debt + 1 unit.
#[test]
fn repay_is_capped_at_debt() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_repay(usdc(), U128(50_000_000), "r".into());
    let id = op_id(&v);
    let debt = r#"{"token_id":"usdc.near","balance":"20000000000000000000","shares":"20000000000000000000"}"#;
    cb(DAY_NS, vec![positions("", debt)]);
    let _ = v.on_repay_precheck(id);
    assert_eq!(v.in_flight.as_ref().unwrap().amount_in, U128(20_000_001));
}

#[test]
fn repay_without_debt_fails() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_repay(usdc(), U128(50_000_000), "r".into());
    let id = op_id(&v);
    cb(DAY_NS, vec![positions("", "")]);
    let _ = v.on_repay_precheck(id);
    assert!(v.in_flight.is_none());
    assert_eq!(last_note(&v), "no_debt");
}

// Finding 1: the signed amountOut must be close to the oracle price (bounds appFees skimming).
fn intents_op(v: &mut Vault, min_out: u128) -> u64 {
    set(agent(), 0, DAY_NS);
    let day = v.reserve_outflow(&usdc(), 5_000_000);
    let id = v.begin_op(OpKind::IntentsRoute, Some(usdc()), 5_000_000, Some(wnear()), 5_000_000, day, "r".into());
    let o = v.op_mut(id).unwrap();
    o.min_out = U128(min_out);
    o.deposit_address = Some("abc.near".into());
    o.quote_hash = Some("00".repeat(32));
    id
}

#[test]
fn intents_quote_with_skimmed_output_is_rejected() {
    let mut v = setup();
    v.policy.intents_enabled = true;
    // USDC $1, NEAR $5: 5 USDC is worth 1 wNEAR. Slippage 1% → min_out floor 0.99; spread 0.5% → 0.995.
    let min_out = 990 * 10u128.pow(21);
    let id = intents_op(&mut v, min_out);
    let prices = || vec![price_json("100000000", DAY_NS), price_json("500000000", DAY_NS), ok("\"0\""), ok("\"0\"")];
    // amountOut 0.991 wNEAR: inside slippage but ~0.9% skimmed → rejected
    cb(DAY_NS, prices());
    let _ = v.on_intents_precheck(id, U128(991 * 10u128.pow(21)));
    assert!(v.in_flight.is_none());
    assert_eq!(last_note(&v), "quote_spread");
    set(owner(), 0, DAY_NS);
    assert_eq!(v.remaining_daily(usdc()), U128(200_000_000), "reservation released");
    // a fair quote passes the price checks and funds the route
    let id = intents_op(&mut v, min_out);
    cb(DAY_NS, prices());
    let _ = v.on_intents_precheck(id, U128(998 * 10u128.pow(21)));
    assert!(v.in_flight.as_ref().unwrap().funds_sent);
}

#[test]
fn intents_quote_marked_used_only_when_funded() {
    let mut v = setup();
    let id = intents_op(&mut v, 1);
    let hash = [0u8; 32];
    assert!(!v.used_quotes.contains(&hash));
    cb(DAY_NS, vec![ok("null")]);
    v.on_intents_funded(id);
    assert!(v.used_quotes.contains(&hash));
}

// Finding 2: signed fields that could redirect the output are rejected; unknown fields too.
#[test]
fn intents_quote_rejects_delivery_and_unknown_fields() {
    set(owner(), 0, 0);
    let live = QUOTE.replace("\"dry\":true", "\"dry\":false");
    let with = |extra: &str| live.replacen('{', &format!("{{{extra},"), 1);
    let me = acc("sprout-demo.near");
    for f in [
        r#""virtualChainRecipient":"0xabc""#,
        r#""customRecipientMsg":"steal""#,
        r#""depositMemo":"123""#,
    ] {
        let q: intents::SignedQuote = near_sdk::serde_json::from_str(&with(f)).unwrap();
        assert!(intents::check_vault_quote(&q, &me, 0).is_err(), "{f} must be rejected");
    }
    assert!(near_sdk::serde_json::from_str::<intents::SignedQuote>(&with(r#""somethingNew":1"#)).is_err());
    // the real quote's own fields are all understood
    assert!(near_sdk::serde_json::from_str::<intents::SignedQuote>(QUOTE).is_ok());
}

// Finding 9: return-funds methods respect pause / feature flags; wrapping counts against the cap.
#[test]
#[should_panic(expected = "ERR_PAUSED")]
fn recover_ref_respects_pause_for_agent() {
    let mut v = setup();
    set(owner(), 1, DAY_NS);
    v.pause();
    set(agent(), 0, DAY_NS);
    let _ = v.recover_ref(usdc());
}

#[test]
#[should_panic(expected = "ERR_BURROW_DISABLED")]
fn withdraw_supplied_needs_burrow_enabled() {
    let mut v = setup();
    v.policy.burrow_enabled = false;
    set(agent(), 0, DAY_NS);
    let _ = v.agent_withdraw_supplied(usdc(), "r".into());
}

#[test]
fn wrap_counts_against_wnear_cap() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_wrap_near(U128(2 * 10u128.pow(24)), "r".into());
    set(owner(), 0, DAY_NS);
    assert_eq!(v.remaining_daily(wnear()), U128(18 * 10u128.pow(24)));
}

// Finding 5: Burrow's current risk settings replace the cached ones.
#[test]
fn token_config_refreshes_from_burrow() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let assets: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(
        r#"[{"token_id":"wrap.near","config":{"volatility_ratio":6000,"extra_decimals":0}}]"#,
    )
    .unwrap();
    v.refresh_token_configs(&assets).unwrap();
    assert_eq!(v.tokens.get(&wnear()).unwrap().volatility_ratio_bps, 6000);
    let bad: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(r#"[{"token_id":"wrap.near","config":{"volatility_ratio":0,"extra_decimals":0}}]"#).unwrap();
    assert!(v.refresh_token_configs(&bad).is_err());
}

// Info: owner passthroughs wait for the agent's op, so reconciliation stays correct.
#[test]
#[should_panic(expected = "ERR_OP_IN_FLIGHT")]
fn owner_burrow_waits_for_agent_op() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let _ = v.agent_borrow(usdc(), U128(1_000_000), "r".into());
    set(owner(), 1, DAY_NS);
    let _ = v.owner_burrow(near_sdk::serde_json::json!([]), false);
}

#[test]
fn intents_withdraw_records_actual_amount() {
    let mut v = setup();
    set(agent(), 0, DAY_NS);
    let id = v.begin_op(OpKind::IntentsWithdraw, None, 0, Some(usdc()), 0, 0, "r".into());
    cb(DAY_NS, vec![ok("\"0\"")]);
    v.on_intents_withdrawn(id, U128(5_000_000));
    assert_eq!(last_note(&v), "intents_withdraw_refunded");
}

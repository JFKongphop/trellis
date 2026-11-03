import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type DecideInput } from "./decide.ts";
import { usdValue, healthFactorBps, type Price } from "./health.ts";
import type { Snapshot, TokenInfo } from "./vault.ts";
import type { Session } from "./store.ts";

const WNEAR = "wrap.near";
const USDC = "usdc.near";
const E24 = 10n ** 24n;
const AGENT = "agent.trellis.near";

const tokens = new Map<string, TokenInfo>([
  [WNEAR, { decimals: 24, burrow_extra_decimals: 0, price_id: "a".repeat(64), volatility_ratio_bps: 7500 }],
  [USDC, { decimals: 6, burrow_extra_decimals: 12, price_id: "b".repeat(64), volatility_ratio_bps: 9500 }],
]);
const price = (p: bigint): Price => ({ price: p, conf: 0n, expo: -8, publishTime: 0 });

/** 15 wNEAR collateral, 20 USDC debt, NEAR at `nearE8`. */
function snap(nearE8: bigint, over: Partial<Snapshot> = {}): Snapshot {
  const prices = new Map([[WNEAR, price(nearE8)], [USDC, price(100_000_000n)]]);
  const collateral = [{ token_id: WNEAR, balance: 15n * E24 }];
  const borrowed = [{ token_id: USDC, balance: 20n * 10n ** 18n }];
  const collateralLegs = [{ valueUsd: usdValue(15n * E24, 24, prices.get(WNEAR)!), volatilityRatioBps: 7500 }];
  const debtLegs = [{ valueUsd: usdValue(20n * 10n ** 18n, 18, prices.get(USDC)!), volatilityRatioBps: 9500 }];
  return {
    vaultId: "v1.trellis.near",
    status: { owner: "alice.near", agent: AGENT, paused: false, in_flight: null },
    policy: {
      allowed_tokens: [WNEAR, USDC], allowed_ref_pools: [4512],
      per_action_cap: [[WNEAR, (20n * E24).toString()], [USDC, "100000000"]],
      daily_cap: [[WNEAR, (50n * E24).toString()], [USDC, "300000000"]],
      max_slippage_bps: 200, max_intents_spread_bps: 50, min_health_factor_bps: 15000, deleverage_trigger_bps: 13000, emergency_floor_bps: 11000,
      max_price_age_sec: 60, max_price_conf_bps: 100, burrow_enabled: true, ref_enabled: true, intents_enabled: false,
    },
    protocols: { burrow: "b", ref_exchange: "r", oracle: "o", intents: "i", wrap: WNEAR },
    tokens, prices, priceError: null, collateral, borrowed,
    balances: new Map([[WNEAR, 0n], [USDC, 0n]]),
    remainingDaily: new Map([[WNEAR, 50n * E24], [USDC, 300_000_000n]]),
    hfBps: healthFactorBps(collateralLegs, debtLegs),
    collateralLegs, debtLegs,
    ...over,
  };
}

const input = (s: Snapshot, session?: Session): DecideInput => ({
  snap: s, session, agentId: AGENT, marginBps: 300, nowMs: 1_000_000, syncDelayMs: 6_500, pool: 4512,
});

test("healthy position → idle", () => {
  const d = decide(input(snap(500_000_000n)));
  assert.equal(d.type, "idle");
});

test("HF below trigger → start a session on the right tokens", () => {
  const d = decide(input(snap(240_000_000n))); // HF ≈ 1.2825
  assert.equal(d.type, "start_session");
  if (d.type === "start_session") {
    assert.equal(d.session.collateralToken, WNEAR);
    assert.equal(d.session.debtToken, USDC);
    assert.equal(d.session.stage, "withdraw");
  }
});

test("withdraw stage sizes the withdrawal to land at floor + margin", () => {
  const session: Session = { stage: "withdraw", collateralToken: WNEAR, debtToken: USDC, amount: "0", startedAt: 0, cycles: 0 };
  const d = decide(input(snap(240_000_000n), session));
  assert.equal(d.type, "act");
  if (d.type === "act") {
    assert.equal(d.action.method, "agent_withdraw_collateral");
    assert.equal(d.action.args.deleverage, true);
    const amt = BigInt(d.action.args.amount as string);
    assert.ok(amt > 17n * 10n ** 23n && amt < 18n * 10n ** 23n, `amount=${amt}`); // ≈ 1.78 wNEAR → HF 1.13
  }
});

test("idle debt token is used to repay first", () => {
  const session: Session = { stage: "withdraw", collateralToken: WNEAR, debtToken: USDC, amount: "0", startedAt: 0, cycles: 0 };
  const s = snap(240_000_000n, { balances: new Map([[WNEAR, 0n], [USDC, 5_000_000n]]) });
  const d = decide(input(s, session));
  assert.equal(d.type, "act");
  if (d.type === "act") {
    assert.equal(d.action.method, "agent_repay");
    assert.equal(d.action.args.amount, "5000000");
  }
});

test("swap then repay stages", () => {
  const swap: Session = { stage: "swap", collateralToken: WNEAR, debtToken: USDC, amount: (178n * 10n ** 22n).toString(), startedAt: 0, cycles: 0 };
  const s = snap(240_000_000n, { balances: new Map([[WNEAR, 178n * 10n ** 22n], [USDC, 0n]]) });
  const d1 = decide(input(s, swap));
  assert.ok(d1.type === "act" && d1.action.method === "agent_swap_ref" && d1.action.args.pool_id === 4512);

  const repay: Session = { ...swap, stage: "repay", amount: "4200000" };
  const s2 = snap(240_000_000n, { balances: new Map([[WNEAR, 0n], [USDC, 4_200_000n]]) });
  const d2 = decide(input(s2, repay));
  assert.ok(d2.type === "act" && d2.action.method === "agent_repay" && d2.action.args.amount === "4200000");
});

test("repay never exceeds the debt", () => {
  const repay: Session = { stage: "repay", collateralToken: WNEAR, debtToken: USDC, amount: "50000000", startedAt: 0, cycles: 0 };
  const s = snap(240_000_000n, { balances: new Map([[WNEAR, 0n], [USDC, 50_000_000n]]) });
  const d = decide(input(s, repay));
  assert.ok(d.type === "act" && d.action.args.amount === "20000001", JSON.stringify(d)); // debt 20 USDC + 1 unit
});

test("HF restored → session ends", () => {
  const session: Session = { stage: "withdraw", collateralToken: WNEAR, debtToken: USDC, amount: "0", startedAt: 0, cycles: 2 };
  assert.equal(decide(input(snap(500_000_000n), session)).type, "end_session");
});

test("HF already at the floor with nothing idle → stuck (owner must act)", () => {
  const session: Session = { stage: "withdraw", collateralToken: WNEAR, debtToken: USDC, amount: "0", startedAt: 0, cycles: 0 };
  const d = decide(input(snap(205_000_000n), session)); // HF ≈ 1.095 < floor + margin
  assert.equal(d.type, "stuck");
});

test("submitted op → sync after the delay, not before", () => {
  const submittedNs = (1_000_000n - 2_000n) * 1_000_000n; // 2 s ago
  const s = snap(500_000_000n, { status: { owner: "a", agent: AGENT, paused: false, in_flight: { op_id: "7", kind: "Borrow", state: "Submitted", submitted_at: submittedNs.toString() } } });
  assert.equal(decide(input(s)).type, "idle");
  const later = { ...input(s), nowMs: 1_000_000 + 10_000 };
  assert.equal(decide(later).type, "sync");
});

test("paused vault or different agent → idle", () => {
  assert.equal(decide(input(snap(240_000_000n, { status: { owner: "a", agent: AGENT, paused: true, in_flight: null } }))).type, "idle");
  assert.equal(decide(input(snap(240_000_000n, { status: { owner: "a", agent: "other.near", paused: false, in_flight: null } }))).type, "idle");
});

test("stale prices → idle (never act on bad data)", () => {
  assert.equal(decide(input(snap(240_000_000n, { priceError: "wrap.near: stale_price" }))).type, "idle");
});

// The vault's open deleverage cycle (after a deleverage withdrawal) drives the next steps.
const pd = (over: Partial<{ collateral_left: string; debt_token: string | null; repay_due: string }> = {}) => ({
  collateral_token: WNEAR, collateral_left: (178n * 10n ** 22n).toString(), debt_token: null, repay_due: "0", started_at: "0", ...over,
});
const withPd = (p: ReturnType<typeof pd>, balances: Map<string, bigint>) =>
  snap(240_000_000n, { status: { owner: "a", agent: AGENT, paused: false, in_flight: null, pending_deleverage: p }, balances });

test("open cycle without a local session (restart) → resume at swap", () => {
  const d = decide(input(withPd(pd(), new Map([[WNEAR, 178n * 10n ** 22n], [USDC, 0n]]))));
  assert.ok(d.type === "start_session" && d.session.stage === "swap" && d.session.debtToken === USDC, JSON.stringify(d));
});

test("open cycle → swap the withdrawn collateral, never withdraw again", () => {
  const session: Session = { stage: "withdraw", collateralToken: WNEAR, debtToken: USDC, amount: "0", startedAt: 0, cycles: 0 };
  const d = decide(input(withPd(pd(), new Map([[WNEAR, 178n * 10n ** 22n], [USDC, 0n]])), session));
  assert.ok(d.type === "act" && d.action.method === "agent_swap_ref" && d.action.args.amount_in === (178n * 10n ** 22n).toString(), JSON.stringify(d));
});

test("open cycle, collateral landed in Burrow supplied → pull it back first", () => {
  const session: Session = { stage: "swap", collateralToken: WNEAR, debtToken: USDC, amount: "0", startedAt: 0, cycles: 0 };
  const d = decide(input(withPd(pd(), new Map([[WNEAR, 0n], [USDC, 0n]])), session));
  assert.ok(d.type === "act" && d.action.method === "agent_withdraw_supplied", JSON.stringify(d));
});

test("open cycle, swapped → repay what's due", () => {
  const session: Session = { stage: "repay", collateralToken: WNEAR, debtToken: USDC, amount: "0", startedAt: 0, cycles: 0 };
  const p = pd({ collateral_left: "0", debt_token: USDC, repay_due: "4200000" });
  const d = decide(input(withPd(p, new Map([[WNEAR, 0n], [USDC, 4_200_000n]])), session));
  assert.ok(d.type === "act" && d.action.method === "agent_repay" && d.action.args.amount === "4200000", JSON.stringify(d));
});

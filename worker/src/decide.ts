// Pure decision logic for automatic protection. No I/O: given a snapshot and the current deleverage
// session, return the next action. The vault re-checks everything, so a bug here wastes gas but can't
// break the owner's rules.
//
// Deleverage session (starts when HF < deleverage_trigger, ends when HF >= min_health_factor):
//   withdraw collateral (HF may dip to emergency_floor + margin) → swap it to the debt token → repay → repeat.
// After a deleverage withdrawal the vault keeps its own record (`pending_deleverage`) and only allows
// swap + repay until the cycle closes. That record wins over the local session (e.g. after a restart).
import { BPS, collateralValueForTarget, unitsForValue } from "./health.ts";
import type { Session } from "./store.ts";
import type { PendingDeleverage, Snapshot } from "./vault.ts";

export type Action = { method: string; args: Record<string, unknown>; label: string; why: string };
export type Decision =
  | { type: "idle"; why: string }
  | { type: "sync"; why: string }
  | { type: "start_session"; session: Session; why: string }
  | { type: "end_session"; why: string }
  | { type: "act"; action: Action }
  | { type: "stuck"; why: string };

export type DecideInput = {
  snap: Snapshot;
  session: Session | undefined;
  agentId: string;
  marginBps: number;
  nowMs: number;
  syncDelayMs: number;
  /** Allowlisted pool for collateral → debt (resolved by the caller). */
  pool: number | null;
};

export function decide(i: DecideInput): Decision {
  const { snap, session } = i;
  const p = snap.policy;
  if (snap.status.paused) return { type: "idle", why: "vault paused" };
  if (snap.status.agent !== i.agentId) return { type: "idle", why: "agent not set to this worker" };
  const op = snap.status.in_flight;
  if (op) {
    if (op.state !== "Submitted") return { type: "idle", why: "op in progress" };
    const since = op.submitted_at ? Number(BigInt(op.submitted_at) / 1_000_000n) : 0;
    return i.nowMs - since >= i.syncDelayMs ? { type: "sync", why: `reconcile op ${op.op_id}` } : { type: "idle", why: "waiting to sync" };
  }
  if (!p.burrow_enabled) return { type: "idle", why: "burrow disabled" };
  if (snap.priceError) return { type: "idle", why: `prices unavailable (${snap.priceError})` };
  const hf = snap.hfBps;

  const pd = snap.status.pending_deleverage;
  if (pd) {
    if (!session) {
      const debtToken = pd.debt_token ?? largestDebt(snap);
      if (!debtToken) return { type: "stuck", why: "deleverage cycle open but no debt token found" };
      return {
        type: "start_session",
        session: { stage: "swap", collateralToken: pd.collateral_token, debtToken, amount: pd.collateral_left, startedAt: i.nowMs, cycles: 0 },
        why: "vault has an open deleverage cycle",
      };
    }
    return finishCycle(i, pd, session.debtToken);
  }

  if (!session) {
    if (hf === null) return { type: "idle", why: "no debt" };
    if (hf >= BigInt(p.deleverage_trigger_bps)) return { type: "idle", why: `HF ${fmt(hf)} healthy` };
    // pick the largest collateral and debt legs that the policy allows
    const coll = largest(snap.collateral, snap, p.allowed_tokens);
    const debt = largest(snap.borrowed, snap, p.allowed_tokens);
    if (!coll || !debt) return { type: "stuck", why: "position uses tokens outside the policy" };
    return {
      type: "start_session",
      session: { stage: "withdraw", collateralToken: coll, debtToken: debt, amount: "0", startedAt: i.nowMs, cycles: 0 },
      why: `HF ${fmt(hf)} < trigger ${fmt(BigInt(p.deleverage_trigger_bps))}`,
    };
  }

  const coll = session.collateralToken;
  const debtTok = session.debtToken;
  switch (session.stage) {
    case "withdraw": {
      if (hf === null || hf >= BigInt(p.min_health_factor_bps)) return { type: "end_session", why: `HF ${hf === null ? "∞" : fmt(hf)} restored` };
      // Idle debt-token in the vault? Repay with it first (cheapest way to raise HF).
      const idleDebt = snap.balances.get(debtTok) ?? 0n;
      if (idleDebt > dust(snap, debtTok)) {
        return act("agent_repay", { token: debtTok, amount: repayAmount(snap, debtTok, idleDebt).toString() }, `repay ${debtTok} with idle balance`, `HF ${fmt(hf)}; vault holds idle ${debtTok}`);
      }
      const info = snap.tokens.get(coll)!;
      const price = snap.prices.get(coll)!;
      const target = BigInt(p.emergency_floor_bps + i.marginBps);
      const value = collateralValueForTarget(snap.collateralLegs, snap.debtLegs, info.volatility_ratio_bps, target);
      let units = unitsForValue(value, info.decimals, price);
      const collBalance = snap.collateral.find((e) => e.token_id === coll)?.balance ?? 0n;
      const collUnits = collBalance / 10n ** BigInt(info.burrow_extra_decimals);
      if (units > collUnits) units = collUnits;
      // the swap that follows is capped: don't withdraw more than we can swap today
      const swapCap = minBig(capOf(p.per_action_cap, coll), snap.remainingDaily.get(coll) ?? 0n);
      if (units > swapCap) units = swapCap;
      if (units <= dust(snap, coll)) {
        return { type: "stuck", why: `HF ${fmt(hf)} at or below floor+margin and no idle ${debtTok}: owner must add collateral or repay` };
      }
      return act(
        "agent_withdraw_collateral",
        { token: coll, amount: units.toString(), deleverage: true },
        `withdraw ${coll} to deleverage`,
        `HF ${fmt(hf)} < min ${fmt(BigInt(p.min_health_factor_bps))}; target HF after withdraw ${fmt(target)}`,
      );
    }
    case "swap": {
      if (i.pool === null) return { type: "stuck", why: `no allowlisted pool for ${coll} → ${debtTok}` };
      const amount = minBig(BigInt(session.amount), snap.balances.get(coll) ?? 0n);
      if (amount <= dust(snap, coll)) return { type: "stuck", why: `nothing to swap (${session.amount} expected)` };
      return act(
        "agent_swap_ref",
        { pool_id: i.pool, token_in: coll, token_out: debtTok, amount_in: amount.toString() },
        `swap ${coll} → ${debtTok}`,
        "deleverage: convert withdrawn collateral to the debt token",
      );
    }
    case "repay": {
      const have = minBig(BigInt(session.amount), snap.balances.get(debtTok) ?? 0n);
      if (have <= 0n) return { type: "stuck", why: "nothing to repay" };
      return act("agent_repay", { token: debtTok, amount: repayAmount(snap, debtTok, have).toString() }, `repay ${debtTok}`, "deleverage: repay debt");
    }
  }
}

/** Finish the vault's open deleverage cycle: pull back / swap the withdrawn collateral, then repay. */
function finishCycle(i: DecideInput, pd: PendingDeleverage, sessionDebt: string): Decision {
  const { snap } = i;
  const p = snap.policy;
  const coll = pd.collateral_token;
  const debtTok = pd.debt_token ?? sessionDebt;
  const left = BigInt(pd.collateral_left);
  const due = BigInt(pd.repay_due);
  if (left > dust(snap, coll)) {
    const bal = snap.balances.get(coll) ?? 0n;
    if (bal <= dust(snap, coll)) {
      // the withdrawal landed as Burrow "supplied": bring it into the vault first
      return act("agent_withdraw_supplied", { token: coll }, `pull ${coll} back from Burrow`, "deleverage: withdrawn collateral is in Burrow supplied");
    }
    if (i.pool === null) return { type: "stuck", why: `no allowlisted pool for ${coll} → ${debtTok}` };
    const swapCap = minBig(capOf(p.per_action_cap, coll), snap.remainingDaily.get(coll) ?? 0n);
    const amount = minBig(minBig(left, bal), swapCap);
    if (amount <= dust(snap, coll)) return { type: "stuck", why: `swap cap for ${coll} used up today; deleverage cycle can't finish` };
    return act(
      "agent_swap_ref",
      { pool_id: i.pool, token_in: coll, token_out: debtTok, amount_in: amount.toString() },
      `swap ${coll} → ${debtTok}`,
      "deleverage: convert withdrawn collateral to the debt token",
    );
  }
  if (due > 0n) {
    const have = minBig(due, snap.balances.get(debtTok) ?? 0n);
    if (have <= 0n) return { type: "stuck", why: `deleverage cycle needs ${due} ${debtTok} repaid but the vault holds none` };
    return act("agent_repay", { token: debtTok, amount: repayAmount(snap, debtTok, have).toString() }, `repay ${debtTok}`, "deleverage: repay debt");
  }
  return { type: "idle", why: "deleverage cycle closing" };
}

/** Largest debt token by value (when the vault's cycle doesn't say yet). */
export function largestDebt(snap: Snapshot): string | null {
  return largest(snap.borrowed, snap, snap.policy.allowed_tokens);
}

function act(method: string, args: Record<string, unknown>, label: string, why: string): Decision {
  return { type: "act", action: { method, args, label, why } };
}

/** Repay at most the current debt (+1 unit for rounding); overpayment would land as Burrow "supplied". */
function repayAmount(snap: Snapshot, token: string, have: bigint): bigint {
  const info = snap.tokens.get(token);
  const debtInner = snap.borrowed.find((e) => e.token_id === token)?.balance ?? 0n;
  const debtUnits = info ? debtInner / 10n ** BigInt(info.burrow_extra_decimals) + 1n : have;
  return minBig(have, debtUnits);
}

function largest(list: { token_id: string; balance: bigint }[], snap: Snapshot, allowed: string[]): string | null {
  let best: { t: string; v: bigint } | null = null;
  for (const e of list) {
    if (!allowed.includes(e.token_id)) return null;
    const info = snap.tokens.get(e.token_id);
    const p = snap.prices.get(e.token_id);
    if (!info || !p) return null;
    const v = (e.balance * p.price) / 10n ** BigInt(info.burrow_extra_decimals + info.decimals);
    if (!best || v > best.v) best = { t: e.token_id, v };
  }
  return best?.t ?? null;
}

/** ~$0.01 worth, to ignore dust. */
function dust(snap: Snapshot, token: string): bigint {
  const info = snap.tokens.get(token);
  const p = snap.prices.get(token);
  if (!info || !p || p.price <= 0n) return 0n;
  // units for $0.01: 10^dec × 0.01 / (price × 10^expo)
  const num = 10n ** BigInt(info.decimals);
  const scale = p.expo + 2; // 0.01 = 10^-2
  return scale >= 0 ? num / (p.price * 10n ** BigInt(scale)) : (num * 10n ** BigInt(-scale)) / p.price;
}

function capOf(caps: [string, string][], token: string): bigint {
  const c = caps.find(([t]) => t === token);
  return c ? BigInt(c[1]) : 0n;
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const fmt = (bps: bigint) => (Number(bps) / Number(BPS)).toFixed(3);

import "server-only";

// Vault-mode plan builder (frontend-spec §3.4): validated steps → ordered
// `agent_*` calls for the worker + Guardian rows, pre-checked against the
// vault's policy (tokens, pools, per-action + daily caps, HF floor). This is
// ADVISORY: the vault contract re-checks every call (vault-spec §5.3), so a
// wrong preview can only cause a rejected step, never a policy breach.

import {
  NATIVE_NEAR_ID,
  TRELLIS_AGENT,
  poolFor,
} from "@/lib/near/config";
import { readBalances } from "@/lib/near/balances";
import { projectHealth, positionAmountsBase, type HealthDelta } from "@/lib/near/burrow";
import {
  hfFromBps,
  vaultPolicy,
  vaultRemainingDaily,
  vaultStatus,
  vaultTokens,
} from "@/lib/near/vault";
import { fromBase, toBase } from "@/lib/near/tx";
import type { VaultStep } from "@/lib/ai/plan-schema";
import type { GuardianRow, PlanRisk, ResolvedStep, VaultCall, VaultPlan } from "@/lib/ai/plan-types";
import { PlanError, fmt, ftId, quoteRef, resolveToken, type ResolvedToken } from "@/lib/plan/common";

export async function buildVaultPlan(
  owner: string,
  vaultId: string,
  steps: VaultStep[],
  agentRisks: PlanRisk[] = [],
): Promise<VaultPlan> {
  if (steps.length === 0) throw new PlanError("Plan has no steps.");
  const [status, policy, tokens, bal] = await Promise.all([
    vaultStatus(vaultId),
    vaultPolicy(vaultId),
    vaultTokens(vaultId),
    readBalances(vaultId),
  ]);
  if (!status || !policy) throw new PlanError(`${vaultId} is not a Trellis vault.`);
  if (status.owner !== owner) throw new PlanError(`${vaultId} belongs to ${status.owner}, not ${owner}.`);

  const guardian: GuardianRow[] = [];
  const block = (id: string, title: string, note: string) =>
    guardian.push({ id, source: "check", level: "block", title, note });

  // Agent state
  if (!status.agent) block("agent", "No agent authorized", "Set the Trellis agent in your vault rules first (/vault/setup).");
  else if (status.agent !== TRELLIS_AGENT) block("agent", "Different agent", `The vault authorizes ${status.agent}, not ${TRELLIS_AGENT}.`);
  else if (status.agent_expires_at && BigInt(status.agent_expires_at) < BigInt(Date.now()) * BigInt(1e6)) {
    block("agent", "Agent expired", "The agent's permission expired. Renew it in your vault rules.");
  }
  if (status.paused) block("paused", "Vault is paused", "Resume the agent on the vault dashboard before approving.");
  if (status.in_flight) {
    guardian.push({ id: "inflight", source: "check", level: "flag", title: "An action is still running", note: `Op #${status.in_flight.op_id} (${status.in_flight.kind}) hasn't settled; the worker waits for it before starting.` });
  }

  const registered = new Map(tokens.map(([id, info]) => [id, info]));
  const balances = new Map<string, bigint>(bal.balances.map((b) => [b.tokenId, BigInt(b.balanceRaw)]));
  const get = (id: string) => balances.get(id) ?? BigInt(0);
  const add = (id: string, d: bigint) => balances.set(id, get(id) + d);

  const outflow = new Map<string, bigint>(); // per token, for daily headroom
  const perAction = new Map(policy.per_action_cap.map(([t, c]) => [t, BigInt(c)]));
  const dailyCap = new Map(policy.daily_cap.map(([t, c]) => [t, BigInt(c)]));
  const calls: VaultCall[] = [];
  const resolved: ResolvedStep[] = [];
  const outputs = new Map<string, { token: ResolvedToken; amount: bigint }>();
  const deltas: HealthDelta[] = [];
  const shortfalls: string[] = [];
  let minProjected: number | null | undefined;

  function checkToken(t: ResolvedToken, stepId: string) {
    if (t.native) throw new PlanError("Vault actions use wNEAR, not native NEAR.", 'Use "wrapNear" first, then "wNEAR".');
    if (!policy!.allowed_tokens.includes(t.id)) block(`token-${stepId}-${t.id}`, `${t.symbol} not allowed`, `Your rules don't allow the agent to use ${t.symbol}.`);
    else if (!registered.has(t.id)) block(`reg-${stepId}-${t.id}`, `${t.symbol} not registered`, `Register ${t.symbol} in your vault rules first.`);
  }

  function capOutflow(t: ResolvedToken, amount: bigint, stepId: string) {
    const per = perAction.get(t.id);
    if (per === undefined) {
      block(`cap-${stepId}`, `No limit set for ${t.symbol}`, `The vault rejects outflows of tokens without per-action and daily limits.`);
      return;
    }
    if (amount > per) block(`cap-${stepId}`, "Over the per-action limit", `${fmt(fromBase(amount, t.decimals))} ${t.symbol} is more than your ${fmt(fromBase(per, t.decimals))} ${t.symbol} per-action limit.`);
    outflow.set(t.id, (outflow.get(t.id) ?? BigInt(0)) + amount);
  }

  function inputAmount(step: { id: string; origin: unknown }, t: ResolvedToken): bigint {
    const o = step.origin as { from: string; amount?: number; percent?: number; stepId?: string };
    if (o.from === "amount") return toBase(o.amount!, t.decimals);
    if (o.from === "percent") return (get(t.id) * BigInt(Math.round(o.percent! * 100))) / BigInt(10000);
    const out = outputs.get(o.stepId!);
    if (!out) throw new PlanError(`Step "${step.id}" uses output of "${o.stepId}", which doesn't exist or comes later.`);
    if (out.token.id !== t.id) throw new PlanError(`Step "${o.stepId}" outputs ${out.token.symbol}, not ${t.symbol}.`);
    return out.amount;
  }

  function spend(t: ResolvedToken, amount: bigint, stepId: string) {
    if (get(t.id) < amount) shortfalls.push(`${stepId}: needs ${fmt(fromBase(amount, t.decimals))} ${t.symbol}, vault will have ${fmt(fromBase(get(t.id) > BigInt(0) ? get(t.id) : BigInt(0), t.decimals))}`);
    add(t.id, -amount);
  }

  async function projectStep(stepId: string, floorBps: number) {
    const p = await projectHealth(vaultId, deltas).catch(() => null);
    if (!p) return;
    if (minProjected === undefined || (p.after !== null && (minProjected === null || p.after < minProjected))) minProjected = p.after;
    const floor = floorBps / 10000;
    if (p.after !== null && p.after < floor) {
      block(`hf-${stepId}`, `Health factor would drop to ${p.after.toFixed(2)}`, `Your rules require at least ${floor.toFixed(2)}. The vault will reject this step.`);
    }
  }

  for (const step of steps) {
    const refs = [calls.length];
    switch (step.kind) {
      case "wrapNear": {
        const amount = toBase(step.amount, 24);
        const reserve = BigInt(policy.min_near_reserve);
        if (BigInt(status.near_available) - amount < reserve) {
          block(`reserve-${step.id}`, "Would break the NEAR reserve", `The vault keeps ${fmt(fromBase(reserve, 24))} NEAR for gas and storage; it has ${fmt(fromBase(status.near_available, 24))} available.`);
        }
        calls.push({ method: "agent_wrap_near", args: { amount: amount.toString() }, label: `Wrap ${fmt(step.amount)} NEAR into wNEAR` });
        const w = await resolveToken("wnear");
        add(w.id, amount);
        add(NATIVE_NEAR_ID, -amount);
        outputs.set(step.id, { token: w, amount });
        resolved.push({ id: step.id, kind: step.kind, label: `Wrap ${fmt(step.amount)} NEAR in the vault`, refs });
        break;
      }
      case "supply": {
        const t = await resolveToken(step.token);
        checkToken(t, step.id);
        if (!policy.burrow_enabled) block("burrow-off", "Rhea Lending is off", "Your rules don't allow the agent to use Rhea Lending.");
        const amount = inputAmount(step, t);
        spend(t, amount, step.id);
        capOutflow(t, amount, step.id);
        deltas.push({ tokenId: t.id, collateralBase: amount });
        calls.push({ method: "agent_supply", args: { token: t.id, amount: amount.toString() }, label: `Supply ${fmt(fromBase(amount, t.decimals))} ${t.symbol} as collateral` });
        resolved.push({ id: step.id, kind: step.kind, label: `Supply ${fmt(fromBase(amount, t.decimals))} ${t.symbol} to Rhea Lending as collateral`, tokenIn: t.symbol, amountIn: fromBase(amount, t.decimals), refs });
        break;
      }
      case "borrow": {
        const t = await resolveToken(step.token);
        checkToken(t, step.id);
        if (!policy.burrow_enabled) block("burrow-off", "Rhea Lending is off", "Your rules don't allow the agent to use Rhea Lending.");
        const amount = toBase(step.amount, t.decimals);
        deltas.push({ tokenId: t.id, debtBase: amount });
        await projectStep(step.id, policy.min_health_factor_bps);
        const out = amount - BigInt(1);
        add(t.id, out);
        outputs.set(step.id, { token: t, amount: out });
        calls.push({ method: "agent_borrow", args: { token: t.id, amount: amount.toString() }, label: `Borrow ${fmt(step.amount)} ${t.symbol}` });
        resolved.push({ id: step.id, kind: step.kind, label: `Borrow ${fmt(step.amount)} ${t.symbol} into the vault (then sync)`, tokenOut: t.symbol, amountOut: step.amount, refs });
        break;
      }
      case "repay": {
        const t = await resolveToken(step.token);
        checkToken(t, step.id);
        const pos = await positionAmountsBase(vaultId, t.id);
        let amount: bigint;
        if ((step.origin as { from: string }).from === "all") {
          amount = pos.debt + (pos.debt * BigInt(Math.ceil(pos.debtAprPct * 100))) / BigInt(10000 * 52560) + BigInt(1);
          if (get(t.id) < amount && get(t.id) > BigInt(0)) amount = get(t.id);
        } else {
          amount = inputAmount(step, t);
        }
        if (pos.debt === BigInt(0)) block(`repay-${step.id}`, "Nothing to repay", `The vault has no ${t.symbol} debt.`);
        spend(t, amount, step.id);
        deltas.push({ tokenId: t.id, debtBase: -amount });
        calls.push({ method: "agent_repay", args: { token: t.id, amount: amount.toString() }, label: `Repay ${fmt(fromBase(amount, t.decimals))} ${t.symbol}` });
        resolved.push({ id: step.id, kind: step.kind, label: `Repay ${fmt(fromBase(amount, t.decimals))} ${t.symbol} of the vault's debt`, tokenIn: t.symbol, amountIn: fromBase(amount, t.decimals), refs });
        break;
      }
      case "withdrawCollateral": {
        const t = await resolveToken(step.token);
        checkToken(t, step.id);
        const amount = toBase(step.amount, t.decimals);
        deltas.push({ tokenId: t.id, collateralBase: -amount });
        await projectStep(step.id, step.deleverage ? policy.emergency_floor_bps : policy.min_health_factor_bps);
        add(t.id, amount);
        outputs.set(step.id, { token: t, amount });
        calls.push({
          method: "agent_withdraw_collateral",
          args: { token: t.id, amount: amount.toString(), deleverage: !!step.deleverage },
          label: `Withdraw ${fmt(step.amount)} ${t.symbol} collateral${step.deleverage ? " (deleverage)" : ""}`,
        });
        resolved.push({ id: step.id, kind: step.kind, label: `Withdraw ${fmt(step.amount)} ${t.symbol} collateral back to the vault${step.deleverage ? " (deleverage step)" : ""}`, tokenOut: t.symbol, amountOut: step.amount, refs });
        break;
      }
      case "withdrawSupplied": {
        const t = await resolveToken(step.token);
        checkToken(t, step.id);
        calls.push({ method: "agent_withdraw_supplied", args: { token: t.id }, label: `Withdraw supplied ${t.symbol}` });
        resolved.push({ id: step.id, kind: step.kind, label: `Withdraw all plain-supplied ${t.symbol} back to the vault`, refs });
        break;
      }
      case "swap": {
        const tin = await resolveToken(step.token);
        const tout = await resolveToken(step.toToken);
        checkToken(tin, step.id);
        checkToken(tout, step.id);
        if (!policy.ref_enabled) block("ref-off", "Ref swaps are off", "Your rules don't allow the agent to swap on Ref.");
        const pool = poolFor(tin.id, tout.id, policy.allowed_ref_pools);
        if (!pool) {
          throw new PlanError(
            `No pool in the vault's allowlist (${policy.allowed_ref_pools.join(", ") || "none"}) for ${tin.symbol} → ${tout.symbol}.`,
            "Use an allowed pair or ask the user to allow the pool in their rules.",
          );
        }
        const amount = inputAmount(step, tin);
        spend(tin, amount, step.id);
        capOutflow(tin, amount, step.id);
        // The vault computes its own min_out from the oracle; this quote is a preview.
        const q = await quoteRef(pool.id, tin, tout, amount, policy.max_slippage_bps);
        if (q.impactPct !== undefined && q.impactPct * 100 > policy.max_slippage_bps) {
          block(`slip-${step.id}`, `Price vs oracle: ${q.impactPct.toFixed(2)}%`, `Above your ${(policy.max_slippage_bps / 100).toFixed(2)}% max slippage; the vault would refund this swap. Try a smaller amount.`);
        }
        add(tout.id, q.minOut);
        outputs.set(step.id, { token: tout, amount: q.minOut });
        calls.push({
          method: "agent_swap_ref",
          args: { pool_id: pool.id, token_in: ftId(tin), token_out: tout.id, amount_in: amount.toString() },
          label: `Swap ${fmt(fromBase(amount, tin.decimals))} ${tin.symbol} → ${tout.symbol} (pool ${pool.id})`,
        });
        resolved.push({
          id: step.id,
          kind: step.kind,
          label: `Swap ${fmt(fromBase(amount, tin.decimals))} ${tin.symbol} for about ${fmt(fromBase(q.amountOut, tout.decimals))} ${tout.symbol} on Ref pool ${pool.id}`,
          tokenIn: tin.symbol,
          amountIn: fromBase(amount, tin.decimals),
          tokenOut: tout.symbol,
          amountOut: fromBase(q.amountOut, tout.decimals),
          minOut: fromBase(q.minOut, tout.decimals),
          refs,
          pool: pool.id,
        });
        break;
      }
    }
  }

  // Daily headroom (policy headroom row, frontend-spec §4.3)
  for (const [tokenId, used] of outflow) {
    const cap = dailyCap.get(tokenId);
    const decimals = registered.get(tokenId)?.decimals ?? 0;
    const sym = (await resolveToken(tokenId).catch(() => null))?.symbol ?? tokenId;
    if (cap === undefined) continue;
    const remaining = BigInt(await vaultRemainingDaily(vaultId, tokenId));
    guardian.push({
      id: `headroom-${tokenId}`,
      source: "check",
      level: used > remaining ? "block" : "pass",
      title: `Uses ${fmt(fromBase(used, decimals))} of ${fmt(fromBase(remaining, decimals))} ${sym} left today`,
      note: `Daily limit ${fmt(fromBase(cap, decimals))} ${sym}. ${used > remaining ? "This plan goes over it; the vault will reject the step that crosses the limit." : "Within your daily limit."}`,
    });
  }

  let healthBefore: number | null | undefined;
  let healthAfter: number | null | undefined;
  if (deltas.length > 0) {
    const p = await projectHealth(vaultId, deltas).catch(() => null);
    if (p) {
      healthBefore = p.before;
      healthAfter = p.after;
      const min = policy.min_health_factor_bps / 10000;
      const low = minProjected !== undefined && minProjected !== null && minProjected < healthAfter! ? minProjected : healthAfter;
      guardian.push({
        id: "hf-after",
        source: "check",
        level: low === null || low === undefined ? "pass" : low < min ? "block" : low < min + 0.1 ? "flag" : "pass",
        title: `Health factor after: ${healthAfter === null ? "no debt" : healthAfter?.toFixed(2)}`,
        note: `Now ${healthBefore === null ? "no debt" : healthBefore?.toFixed(2)}${low !== healthAfter && low != null ? `, lowest during the plan ${low.toFixed(2)}` : ""}. Your rules require ≥ ${min.toFixed(2)}; the vault checks this before every borrow and withdrawal.${p.notes.length ? " " + p.notes.join(" ") : ""}`,
      });
    }
  }
  const cachedHf = hfFromBps(status.last_health?.health_factor_bps);
  if (calls.length > 1) {
    guardian.unshift({ id: "non-atomic", source: "check", level: "flag", title: `${calls.length} separate agent actions`, note: "The agent runs them one at a time and stops at the first one the vault rejects. Earlier steps stay done." });
  }
  guardian.push({ id: "oracle", source: "check", level: "pass", title: "Checked on-chain by your vault", note: `Every action is re-checked by ${vaultId} against your rules and Rhea's oracle${cachedHf !== null ? ` (last recorded HF ${cachedHf.toFixed(2)})` : ""}.` });
  if (shortfalls.length > 0) guardian.push({ id: "balance", source: "check", level: "block", title: "Insufficient vault balance", note: shortfalls.join("; ") });
  for (const r of agentRisks.slice(0, 6)) guardian.push({ id: `agent-${guardian.length}`, source: "agent", ...r });

  // money-flow graph: which earlier step's output each step uses
  for (const r of resolved) {
    const src = steps.find((x) => x.id === r.id) as { origin?: { from: string; stepId?: string } } | undefined;
    if (src?.origin?.from === "step" && src.origin.stepId) r.fromStep = src.origin.stepId;
  }
  return {
    mode: "vault",
    vaultId,
    owner,
    steps: resolved,
    calls,
    guardian,
    blocked: guardian.some((g) => g.level === "block"),
    summary: resolved.map((s) => s.label).join(" → "),
    healthBefore,
    healthAfter,
    createdAt: Date.now(),
  };
}

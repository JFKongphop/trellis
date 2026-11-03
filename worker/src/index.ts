// Trellis worker: every tick, for each registered vault, either reconcile, protect (deleverage session),
// or run the next owner-approved plan. One job per vault at a time (the vault itself allows one op).
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.ts";
import { decide, fmt, largestDebt } from "./decide.ts";
import { runAction } from "./executor.ts";
import { health } from "./health-status.ts";
import { startServer } from "./server.ts";
import { log, save, state, type Plan, type Session } from "./store.ts";
import { findPool, readSnapshot } from "./vault.ts";
import { agentCall } from "./near.ts";

const BREAKER_THRESHOLD = 3;
const busy = new Set<string>();
let stopping = false;

for (const v of config.initialVaults) {
  state.vaults[v] ??= { owner: "", addedAt: Date.now(), failures: 0, breakerOpen: false };
}
save();

function recordResult(vaultId: string, ok: boolean, why: string) {
  const v = state.vaults[vaultId];
  if (!v) return;
  if (ok) v.failures = 0;
  else if (++v.failures >= BREAKER_THRESHOLD) {
    v.breakerOpen = true;
    log("ALERT_breaker_open", { vault: vaultId, why });
  }
  save();
}

async function protect(vaultId: string): Promise<"handled" | "free"> {
  const snap = await readSnapshot(vaultId);
  let session = state.sessions[vaultId];
  // the pool for the pair being deleveraged: from the session, or the vault's own open cycle
  const pd = snap.status.pending_deleverage;
  const pair = session
    ? [session.collateralToken, pd?.debt_token ?? session.debtToken]
    : pd
      ? [pd.collateral_token, pd.debt_token ?? largestDebt(snap)]
      : null;
  const pool = pair && pair[1] ? await findPool(snap, pair[0]!, pair[1]) : null;
  const d = decide({ snap, session, agentId: config.agentId, marginBps: config.deleverageMarginBps, nowMs: Date.now(), syncDelayMs: config.syncDelayMs, pool });

  switch (d.type) {
    case "idle":
      return session ? "handled" : "free";
    case "sync": {
      log("sync_orphan_op", { vault: vaultId, why: d.why });
      await agentCall(vaultId, "sync_position", {}).catch((e) => log("sync_error", { vault: vaultId, error: String(e).slice(0, 200) }));
      return "handled";
    }
    case "start_session":
      state.sessions[vaultId] = d.session;
      save();
      log("deleverage_start", { vault: vaultId, why: d.why });
      return "handled";
    case "end_session":
      delete state.sessions[vaultId];
      save();
      log("deleverage_end", { vault: vaultId, why: d.why });
      return "free";
    case "stuck":
      log("ALERT_stuck", { vault: vaultId, why: d.why, hf: snap.hfBps === null ? null : fmt(snap.hfBps) });
      recordResult(vaultId, false, d.why);
      return "handled";
    case "act": {
      session = state.sessions[vaultId]!;
      const a = d.action;
      const r = await runAction(vaultId, a.method, a.args, {
        source: "auto_protection",
        why: a.why,
        hf: snap.hfBps === null ? null : snap.hfBps.toString(),
        stage: session.stage,
      });
      log("protect_step", { vault: vaultId, step: a.label, state: r.state, note: r.note, txs: r.txHashes });
      if (r.note === "sync_pending_timeout") {
        // the vault still treats the op as pending; the next ticks reconcile it (no breaker strike)
        return "handled";
      }
      if (r.state !== "settled") {
        recordResult(vaultId, false, `${a.method}: ${r.note}`);
        return "handled";
      }
      recordResult(vaultId, true, "");
      // advance the session from what actually settled
      if (a.method === "agent_withdraw_collateral") {
        if (!r.amountOut || r.amountOut === "0") {
          // landed as Burrow "supplied": the vault's open cycle tells decide() to pull it back
          log("withdraw_to_supplied", { vault: vaultId, note: r.note });
          Object.assign(session, { stage: "swap" } satisfies Partial<Session>);
        } else Object.assign(session, { stage: "swap", amount: r.amountOut } satisfies Partial<Session>);
      } else if (a.method === "agent_swap_ref") {
        Object.assign(session, { stage: "repay", amount: r.amountOut ?? "0" } satisfies Partial<Session>);
      } else if (a.method === "agent_repay") {
        Object.assign(session, { stage: "withdraw", amount: "0", cycles: session.cycles + 1 } satisfies Partial<Session>);
      }
      save();
      return "handled";
    }
  }
}

async function runPlan(plan: Plan) {
  plan.status = "running";
  save();
  for (const step of plan.steps) {
    step.status = "running";
    save();
    const r = await runAction(plan.vaultId, step.method, step.args, { source: "owner_approved_plan", planId: plan.planId, reasoning: plan.reasoning, step: step.label });
    step.txHash = r.txHashes[0];
    step.note = r.note;
    step.status = r.state === "settled" ? "done" : "failed";
    save();
    if (r.state !== "settled") {
      plan.status = "failed";
      plan.error = `${step.label}: ${r.note ?? "failed"}`;
      save();
      recordResult(plan.vaultId, false, plan.error);
      return;
    }
  }
  plan.status = "done";
  save();
  recordResult(plan.vaultId, true, "");
}

async function handleVault(vaultId: string) {
  if (busy.has(vaultId) || state.vaults[vaultId]?.breakerOpen) return;
  busy.add(vaultId);
  try {
    // protection always has priority over owner-approved plans
    if ((await protect(vaultId)) === "handled") return;
    const next = Object.values(state.plans)
      .filter((p) => p.vaultId === vaultId && p.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next) {
      log("plan_start", { plan: next.planId, vault: vaultId });
      await runPlan(next);
      log("plan_end", { plan: next.planId, status: next.status, error: next.error });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    health.lastError = msg.slice(0, 300);
    log("vault_error", { vault: vaultId, error: msg.slice(0, 300) });
  } finally {
    busy.delete(vaultId);
  }
}

async function loop() {
  while (!stopping) {
    const vaults = Object.keys(state.vaults);
    // fire and forget per vault: a long plan on one vault doesn't block the others
    for (const v of vaults) void handleVault(v);
    health.lastTickAt = Date.now();
    await sleep(config.tickMs);
  }
}

const server = startServer();
log("worker_start", { agent: config.agentId, vaults: Object.keys(state.vaults).length, tickMs: config.tickMs });
void loop();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopping = true;
    log("worker_stopping", { busy: [...busy] });
    server.close();
    for (let i = 0; i < 60 && busy.size > 0; i++) await sleep(1_000); // let in-flight actions finish
    save();
    process.exit(0);
  });
}

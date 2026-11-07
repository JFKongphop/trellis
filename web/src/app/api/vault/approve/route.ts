import { sessionAccount } from "@/lib/server/auth";
import { verifyPlan } from "@/lib/server/plan-token";
import { WorkerUnavailable, workerSubmitPlan } from "@/lib/server/worker";
import { vaultOwner } from "@/lib/near/vault";
import { AGENT_ARG_KEYS, AGENT_METHODS, type AgentMethod } from "@/lib/ai/plan-types";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";

// Each plan runs once per server instance; the worker also dedupes by planId.
const submitted = new Map<string, number>();

/**
 * Owner approves a previewed vault plan (frontend-spec §3.4 / §7):
 * session (NEP-413) must be the vault owner, token unexpired and unused.
 * Even if abused, the vault contract still enforces the policy: this route
 * only decides WHEN the agent acts, not WHAT it may do.
 */
export async function POST(req: Request) {
  const account = await sessionAccount();
  if (!account) return json({ error: "Sign in with your wallet first." }, 401);
  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  const claims = verifyPlan(body?.token ?? "");
  if ("error" in claims) return json({ error: claims.error }, 400);
  if (claims.owner !== account) return json({ error: "This plan was prepared for another account." }, 403);
  try {
    const owner = await vaultOwner(claims.vaultId);
    if (owner !== account) return json({ error: "Only the vault owner can approve its plans." }, 403);
  } catch (e) {
    return json({ error: `Couldn't read the vault owner: ${errorMessage(e)}` }, 502);
  }
  for (const c of claims.calls) {
    if (!(AGENT_METHODS as readonly string[]).includes(c.method)) return json({ error: `Method ${c.method} not allowed` }, 400);
    const allowed = AGENT_ARG_KEYS[c.method as AgentMethod];
    if (Object.keys(c.args).some((k) => !allowed.includes(k))) return json({ error: `Unexpected args for ${c.method}` }, 400);
  }
  const now = Date.now();
  for (const [k, t] of submitted) if (now - t > 10 * 60_000) submitted.delete(k);
  if (submitted.has(claims.planId)) return json({ planId: claims.planId, duplicate: true }, 202);
  try {
    await workerSubmitPlan({
      planId: claims.planId,
      vaultId: claims.vaultId,
      owner: claims.owner,
      steps: claims.calls,
      reasoning: claims.reasoning,
    });
    submitted.set(claims.planId, now);
    return json({ planId: claims.planId }, 202);
  } catch (e) {
    return json({ error: errorMessage(e) }, e instanceof WorkerUnavailable ? 503 : 502);
  }
}

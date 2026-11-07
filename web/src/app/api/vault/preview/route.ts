import { replayEnabled, replayVaultPlan } from "@/lib/server/demo-replay";
import { z } from "zod";
import { buildVaultPlan } from "@/lib/plan/build-vault";
import { PlanError } from "@/lib/plan/common";
import { riskSchema, vaultStepSchema } from "@/lib/ai/plan-schema";
import { isValidAccountId } from "@/lib/near/config";
import { factoryVaultOf } from "@/lib/near/vault";
import { signPlan } from "@/lib/server/plan-token";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  accountId: z.string(),
  steps: z.array(vaultStepSchema).min(1).max(12),
  risks: z.array(riskSchema).max(6).optional(),
  reasoning: z.string().max(2000).optional(),
});

/**
 * Vault-mode preview: steps → agent_* calls checked against the vault's
 * policy, plus a signed 5-minute approval token covering exactly these calls.
 */
export async function POST(req: Request) {
  if (replayEnabled()) return json(replayVaultPlan());
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: `Invalid plan: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }, 400);
  const { accountId, steps, risks, reasoning } = parsed.data;
  if (!isValidAccountId(accountId)) return json({ error: "Invalid NEAR account id" }, 400);
  try {
    const vaultId = await factoryVaultOf(accountId);
    if (!vaultId) return json({ error: "This account has no Trellis vault yet. Create one at /vault/setup." }, 422);
    const plan = await buildVaultPlan(accountId, vaultId, steps, risks);
    const { token, claims } = signPlan({ vaultId, owner: accountId, calls: plan.calls, reasoning: (reasoning ?? plan.summary).slice(0, 2000) });
    return json({ plan, approval: { token, planId: claims.planId, expiresAt: claims.exp } });
  } catch (e) {
    return json({ error: `Vault plan failed: ${errorMessage(e)}` }, e instanceof PlanError ? 422 : 502);
  }
}

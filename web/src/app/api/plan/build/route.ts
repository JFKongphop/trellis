import { z } from "zod";
import { buildWalletPlan } from "@/lib/plan/build-wallet";
import { PlanError } from "@/lib/plan/common";
import { riskSchema, walletStepSchema } from "@/lib/ai/plan-schema";
import { isValidAccountId } from "@/lib/near/config";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  accountId: z.string(),
  steps: z.array(walletStepSchema).min(1).max(12),
  risks: z.array(riskSchema).max(6).optional(),
});

/**
 * Wallet-mode plan: steps → NEAR transactions + Guardian. Read-only (public
 * chain data); nothing is signed here. The user's wallet signs the result.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: `Invalid plan: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }, 400);
  const { accountId, steps, risks } = parsed.data;
  if (!isValidAccountId(accountId)) return json({ error: "Invalid NEAR account id" }, 400);
  try {
    return json({ plan: await buildWalletPlan(accountId, steps, risks) });
  } catch (e) {
    return json({ error: `Plan build failed: ${errorMessage(e)}` }, e instanceof PlanError ? 422 : 502);
  }
}

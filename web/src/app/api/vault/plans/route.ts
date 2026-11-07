import { sessionAccount } from "@/lib/server/auth";
import { WorkerUnavailable, workerGetPlan } from "@/lib/server/worker";
import { vaultOwner } from "@/lib/near/vault";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";
// `?id=` instead of a [id] path segment: dynamic segments make Next dev start a worker process
// per request (static paths), which piled up into many GB when it failed.

/** Live status of an approved vault plan (proxies the worker; owner only). */
export async function GET(req: Request) {
  const account = await sessionAccount();
  if (!account) return json({ error: "Sign in with your wallet first." }, 401);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad plan id" }, 400);
  try {
    const plan = await workerGetPlan(id);
    if ((await vaultOwner(plan.vaultId)) !== account) return json({ error: "Not your vault." }, 403);
    return json(plan);
  } catch (e) {
    return json({ error: errorMessage(e) }, e instanceof WorkerUnavailable ? 503 : 502);
  }
}

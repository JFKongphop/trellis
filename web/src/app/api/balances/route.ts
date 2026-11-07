import { replayBalances, replayEnabled } from "@/lib/server/demo-replay";
import { readBalances } from "@/lib/near/balances";
import { json, parseAccount, errorMessage } from "../_shared";

export const runtime = "nodejs";
// `?account=` instead of a [account] path segment: dynamic segments make Next dev start a worker process
// per request (static paths), which piled up into many GB when it failed.

export async function GET(req: Request) {
  const accountId = parseAccount(new URL(req.url).searchParams.get("account") ?? "");
  if (!accountId) return json({ error: "Invalid NEAR account id" }, 400);
  if (replayEnabled()) return json(replayBalances(accountId));
  try {
    return json(await readBalances(accountId));
  } catch (e) {
    return json({ error: `Balance read failed: ${errorMessage(e)}` }, 502);
  }
}

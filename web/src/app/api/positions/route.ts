import { replayEnabled, replayPosition } from "@/lib/server/demo-replay";
import { readLendingPosition } from "@/lib/near/burrow";
import { json, parseAccount, errorMessage } from "../_shared";

export const runtime = "nodejs";
// `?account=` instead of a [account] path segment: dynamic segments make Next dev start a worker process
// per request (static paths), which piled up into many GB when it failed.

/** Rhea Lending (Burrow) position + health factor for an account. */
export async function GET(req: Request) {
  const accountId = parseAccount(new URL(req.url).searchParams.get("account") ?? "");
  if (!accountId) return json({ error: "Invalid NEAR account id" }, 400);
  if (replayEnabled()) return json(replayPosition(accountId));
  try {
    return json(await readLendingPosition(accountId));
  } catch (e) {
    return json({ error: `Position read failed: ${errorMessage(e)}` }, 502);
  }
}

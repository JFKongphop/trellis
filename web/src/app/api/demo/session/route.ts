import { REPLAY, replayEnabled } from "@/lib/server/demo-replay";
import { demoEnabled, demoState } from "@/lib/server/demo";
import { setSessionCookie } from "@/lib/server/auth";
import { json } from "../../_shared";

export const runtime = "nodejs";

/** Demo-mode stand-in for NEP-413 sign-in: starts a session for the demo account. */
export async function POST() {
  if (!demoEnabled() && !replayEnabled()) return json({ error: "not found" }, 404);
  const accountId = replayEnabled() ? REPLAY.owner : demoState().accountId;
  await setSessionCookie(accountId);
  return json({ accountId });
}

import { setSessionCookie, verifySignIn, type SignInBody } from "@/lib/server/auth";
import { json } from "../../_shared";

export const runtime = "nodejs";

/** Verify a NEP-413 signMessage result and start a session for that account. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as SignInBody | null;
  if (!body) return json({ error: "bad body" }, 400);
  const r = await verifySignIn(body);
  if ("error" in r) return json({ error: r.error }, 401);
  await setSessionCookie(r.accountId);
  return json({ accountId: r.accountId });
}

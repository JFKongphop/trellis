import { clearSessionCookie, sessionAccount } from "@/lib/server/auth";
import { json } from "../../_shared";

export const runtime = "nodejs";

export async function GET() {
  return json({ accountId: await sessionAccount() });
}

export async function DELETE() {
  await clearSessionCookie();
  return json({ ok: true });
}

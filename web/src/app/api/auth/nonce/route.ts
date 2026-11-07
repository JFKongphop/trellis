import { issueNonce } from "@/lib/server/auth";
import { AUTH_MESSAGE, AUTH_RECIPIENT } from "@/lib/auth-message";
import { json } from "../../_shared";

export const runtime = "nodejs";

/** A fresh single-use NEP-413 nonce (base64, 32 bytes) + the exact message to sign. */
export function GET() {
  return json({ nonce: issueNonce(), message: AUTH_MESSAGE, recipient: AUTH_RECIPIENT });
}

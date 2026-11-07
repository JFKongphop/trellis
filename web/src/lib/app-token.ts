// Shared primitives for the API request-signing scheme. Used by BOTH the edge
// proxy (verify) and the browser fetch wrapper (sign), so this file holds
// NO secret — only Web Crypto helpers, the wire format, and constants. The
// signing secret lives server-side only (see proxy.ts / env.ts).
//
// Scheme: the proxy mints a per-session signing key (`app_sk`, a readable
// cookie) derived server-side from the session. The client signs every /api
// request with that key over (method, path+search, ts, nonce); the proxy
// re-derives the key and recomputes the signature. ts+nonce rotate the
// signature on every request; the tight freshness window bounds replay.

// NOTE: the trailing version. Bump it whenever the cookie *scope* changes
// (host-only ⇄ Domain, path, etc.) — a scope change otherwise leaves the old
// cookie alongside the new one under the same name, and the browser sending
// both is a classic source of ambiguous no-session/bad-sig. A new name is
// never duplicated; old cookies are simply never read and expire on their own.
export const SESSION_COOKIE = "__app_session2";
export const APP_SK_COOKIE = "app_sk2";

export const SIG_HEADER = "x-app-sig";
export const TS_HEADER = "x-app-ts";
export const NONCE_HEADER = "x-app-nonce";

// Non-/api path the proxy answers with a fresh session (clients hit it to
// recover from a missing/expired/rotated session without a full page reload).
export const MINT_PATH = "/session";

// 403 reasons a client can recover from by re-minting a session and retrying.
// (cross-site / bad-origin / server-misconfigured are NOT here — re-minting
// can't fix them.)
export const RECOVERABLE_403_REASONS: readonly string[] = [
  "no-session",
  "no-sig",
  "bad-sig",
  "stale",
];

// How long a captured signature stays valid (server-time skew window). Wide
// enough to tolerate normal client/server clock skew, slow networks, and
// backgrounded tabs — too tight and ordinary requests 403 as "stale".
export const SIG_FRESHNESS_MS = 60_000;
// Session lifetime, and the age past which a document request rotates it.
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_ROTATE_MS = 2 * 60 * 60 * 1000;

export function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export async function hmacHex(keyStr: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyStr),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toHex(sig);
}

// Length-checked, constant-time-ish hex comparison.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The exact byte sequence both sides HMAC over. Order/format must match.
export function buildSigPayload(
  method: string,
  pathWithSearch: string,
  ts: string,
  nonce: string,
): string {
  return `${method.toUpperCase()}\n${pathWithSearch}\n${ts}\n${nonce}`;
}

// Canonical path+query that both sides HMAC over. Normalizes query encoding via
// the URLSearchParams serializer so signing (client) and verifying (server) agree
// even when characters like "," are serialized differently on the wire.
export function canonicalPath(pathname: string, search: URLSearchParams): string {
  const qs = search.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function randomHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

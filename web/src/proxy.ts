import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  APP_SK_COOKIE,
  SIG_HEADER,
  TS_HEADER,
  NONCE_HEADER,
  SIG_FRESHNESS_MS,
  SESSION_TTL_MS,
  SESSION_ROTATE_MS,
  MINT_PATH,
  hmacHex,
  timingSafeEqual,
  buildSigPayload,
  canonicalPath,
  randomHex,
} from "@/lib/app-token";
import { getSigningSecret, allowedHosts, cookieDomain } from "@/lib/env";

// Gate for /api/*: a request must carry a valid server-signed session cookie
// AND a fresh per-request signature made with the session's signing key. Page
// (document) requests get those credentials minted/rotated here. See
// app-token.ts for the scheme and its honest limits.

type Session = { sid: string; iat: number };

function forbidden(reason: string): NextResponse {
  // `error` carries the reason too, so clients that only surface `body.error`
  // (most of ours) still show which gate fired instead of a bare "forbidden".
  return new NextResponse(
    JSON.stringify({ error: `forbidden:${reason}`, reason }),
    {
      status: 403,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}

async function verifySession(
  raw: string | undefined,
  secret: string,
): Promise<Session | null> {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [sid, iatStr, mac] = parts;
  const iat = Number(iatStr);
  if (!sid || !Number.isFinite(iat)) return null;
  if (Date.now() - iat > SESSION_TTL_MS) return null;
  const expected = await hmacHex(secret, `sess|${sid}|${iat}`);
  if (!timingSafeEqual(expected, mac)) return null;
  return { sid, iat };
}

// The per-session signing key handed to the client (readable app_sk cookie).
// Derived from the secret + session identity, so the server can re-derive it
// on every request without storing anything.
function deriveSessionKey(
  sid: string,
  iat: number,
  secret: string,
): Promise<string> {
  return hmacHex(secret, `sk|${sid}|${iat}`);
}

function hostMismatch(headerVal: string | null, selfHost: string): boolean {
  if (!headerVal) return false; // absent → can't judge; other layers catch it
  try {
    const h = new URL(headerVal).host;
    return h !== selfHost && !allowedHosts().includes(h);
  } catch {
    return true;
  }
}

async function verifyApiRequest(
  req: NextRequest,
  secret: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Cheap cross-site filter (browsers set Sec-Fetch-Site; scripts that forge it
  // are still stopped by the cookie+signature below — this just rejects obvious
  // cross-site browser calls early).
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "same-site" && sfs !== "none") {
    return { ok: false, reason: "cross-site" };
  }
  const selfHost = req.nextUrl.host;
  if (
    hostMismatch(req.headers.get("origin"), selfHost) ||
    hostMismatch(req.headers.get("referer"), selfHost)
  ) {
    return { ok: false, reason: "bad-origin" };
  }

  const session = await verifySession(
    req.cookies.get(SESSION_COOKIE)?.value,
    secret,
  );
  if (!session) return { ok: false, reason: "no-session" };

  const ts = req.headers.get(TS_HEADER);
  const nonce = req.headers.get(NONCE_HEADER);
  const sig = req.headers.get(SIG_HEADER);
  if (!ts || !nonce || !sig) return { ok: false, reason: "no-sig" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > SIG_FRESHNESS_MS) {
    return { ok: false, reason: "stale" };
  }

  const key = await deriveSessionKey(session.sid, session.iat, secret);
  const expected = await hmacHex(
    key,
    buildSigPayload(
      req.method,
      canonicalPath(req.nextUrl.pathname, req.nextUrl.searchParams),
      ts,
      nonce,
    ),
  );
  if (!timingSafeEqual(expected, sig)) return { ok: false, reason: "bad-sig" };

  return { ok: true };
}

// Write a fresh, internally-consistent (session, signing-key) pair onto `res`.
// sameSite is "lax" (not "strict"): same-origin /api fetches send the cookie
// either way, and lax also lets the session survive a first landing from an
// external link. An explicit Domain (COOKIE_DOMAIN) avoids apex/www duplicates.
async function setFreshSession(
  res: NextResponse,
  secret: string,
  host: string,
): Promise<NextResponse> {
  const sid = randomHex(16);
  const iat = Date.now();
  const mac = await hmacHex(secret, `sess|${sid}|${iat}`);
  const sessionVal = `${sid}.${iat}.${mac}`;
  const appSk = await deriveSessionKey(sid, iat, secret);
  // Only scope to COOKIE_DOMAIN when the current host is actually within it.
  // On a host that isn't (e.g. a *.vercel.app preview) the browser would reject
  // a Domain it doesn't belong to and every /api call would 403 — so fall back
  // to a host-only cookie there.
  const cd = cookieDomain();
  const domain =
    cd && (host === cd || host.endsWith(`.${cd}`)) ? cd : undefined;
  const base = {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    ...(domain ? { domain } : {}),
  };

  res.cookies.set(SESSION_COOKIE, sessionVal, { ...base, httpOnly: true });
  // Readable by client JS on purpose — it signs requests with this key.
  res.cookies.set(APP_SK_COOKIE, appSk, { ...base, httpOnly: false });
  return res;
}

async function mintIfNeeded(
  req: NextRequest,
  secret: string,
): Promise<NextResponse> {
  // Never mint on prefetch. The App Router fires many RSC prefetches at once;
  // rotating concurrently there races the client's signing key (→ bad-sig).
  // Real navigations (and the MINT_PATH recovery route) do the minting.
  if (req.headers.get("next-router-prefetch") === "1") {
    return NextResponse.next();
  }
  const existing = await verifySession(
    req.cookies.get(SESSION_COOKIE)?.value,
    secret,
  );
  const res = NextResponse.next();
  const needsFresh = !existing || Date.now() - existing.iat > SESSION_ROTATE_MS;
  if (!needsFresh) return res;
  return setFreshSession(res, secret, req.nextUrl.host);
}

// MINT_PATH recovery endpoint: unconditionally hand out a fresh session so a
// wedged tab (expired/rotated/duplicate cookie) can re-establish itself with a
// background fetch instead of a full reload. 204 + no-store; no route needed.
function mintFresh(req: NextRequest, secret: string): Promise<NextResponse> {
  const res = new NextResponse(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
  return setFreshSession(res, secret, req.nextUrl.host);
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const secret = getSigningSecret();

  if (!secret) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[proxy] API_SIGNING_SECRET unset — /api protection is DISABLED. " +
          "Add a 32+ char value to web/.env.local (e.g. `openssl rand -hex 32`).",
      );
      return NextResponse.next();
    }
    // In production we refuse rather than serve the API unprotected.
    return isApi ? forbidden("server-misconfigured") : NextResponse.next();
  }

  // Recovery endpoint — see lib/api-client.ts (self-heal on 403).
  if (pathname === MINT_PATH) return mintFresh(req, secret);

  if (isApi) {
    const verdict = await verifyApiRequest(req, secret);
    if (verdict.ok) return NextResponse.next();
    // Log the reason + serving region so intermittent prod 403s are diagnosable
    // (region helps spot per-instance secret skew).
    console.warn(
      `[proxy] 403 ${verdict.reason} ${req.method} ${pathname} ` +
        `region=${req.headers.get("x-vercel-id") ?? "?"}`,
    );
    return forbidden(verdict.reason);
  }

  return mintIfNeeded(req, secret);
}

export const config = {
  // Run on everything except Next internals and static asset files. This covers
  // document/RSC navigations (to mint cookies) and /api/* (to verify).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf|map)$).*)",
  ],
};

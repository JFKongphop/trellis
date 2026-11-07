"use client";

import {
  APP_SK_COOKIE,
  SIG_HEADER,
  TS_HEADER,
  NONCE_HEADER,
  MINT_PATH,
  RECOVERABLE_403_REASONS,
  hmacHex,
  buildSigPayload,
  canonicalPath,
  randomHex,
} from "@/lib/app-token";

// Drop-in `fetch` replacement for calls to our own /api/* routes. Reads the
// per-session signing key from the readable `app_sk` cookie and attaches a
// fresh signature (ts + nonce + HMAC over method/path) on every call, which the
// proxy verifies. If a call is rejected because the session is missing/stale/
// rotated, we silently re-mint a fresh session (GET MINT_PATH) and retry once —
// so a tab whose cookie expired or lost the rotation race heals itself instead
// of wedging until a manual refresh.

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + escaped + "=([^;]*)"),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

async function doSignedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const asRequest = input instanceof Request ? input : null;
  const method = (init?.method ?? asRequest?.method ?? "GET").toUpperCase();
  const urlStr =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : asRequest!.url;
  const url = new URL(urlStr, window.location.origin);
  const pathWithSearch = canonicalPath(url.pathname, url.searchParams);

  const headers = new Headers(init?.headers ?? asRequest?.headers);

  const sk = readCookie(APP_SK_COOKIE);
  if (sk) {
    const ts = Date.now().toString();
    const nonce = randomHex(12);
    const sig = await hmacHex(sk, buildSigPayload(method, pathWithSearch, ts, nonce));
    headers.set(TS_HEADER, ts);
    headers.set(NONCE_HEADER, nonce);
    headers.set(SIG_HEADER, sig);
  }

  return fetch(input, { ...init, headers });
}

// Dedupe concurrent recoveries: many in-flight /api calls that all 403 share a
// single MINT_PATH round-trip, then each retries with the now-fresh cookies.
let remintInFlight: Promise<void> | null = null;
function remintSession(): Promise<void> {
  if (!remintInFlight) {
    remintInFlight = fetch(MINT_PATH, { cache: "no-store" })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        remintInFlight = null;
      });
  }
  return remintInFlight;
}

// A 403 we can fix by re-minting (vs cross-site/bad-origin/misconfig, which we
// must not mask). Clone so the caller can still read the original body.
async function isRecoverable(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const body = (await res.clone().json()) as { reason?: string };
    return !!body.reason && RECOVERABLE_403_REASONS.includes(body.reason);
  } catch {
    return false;
  }
}

export async function signedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await doSignedFetch(input, init);
  if (await isRecoverable(res)) {
    await remintSession();
    return doSignedFetch(input, init); // one retry with the fresh session
  }
  return res;
}

export const apiFetch = signedFetch;

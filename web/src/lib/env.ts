// Server-only environment access for API protection. Do NOT import this from
// client components — it reads non-public secrets. (Currently consumed only by
// src/proxy.ts.)

/**
 * The HMAC secret backing session cookies + request signatures. Returns null
 * when unset or too short so the caller can decide how to degrade (middleware
 * fails open in dev with a warning, and refuses /api in production).
 */
export function getSigningSecret(): string | null {
  const s = process.env.API_SIGNING_SECRET;
  if (!s || s.length < 16) return null;
  return s;
}

/**
 * Extra hostnames (beyond the deployment's own host, which is always allowed)
 * permitted to call /api/*. Parses ALLOWED_ORIGINS as a comma-separated list,
 * stripping scheme and trailing slashes.
 */
export function allowedHosts(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((h) => h.trim().replace(/^https?:\/\//, "").replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Optional explicit Domain for the session cookies. Set COOKIE_DOMAIN to an
 * apex (e.g. "trellis.app") so one session is shared across apex + www and the
 * browser never accumulates duplicate host-only cookies (a stale duplicate is
 * a classic intermittent "no-session"). Unset → host-only (the exact host).
 */
export function cookieDomain(): string | undefined {
  const d = process.env.COOKIE_DOMAIN?.trim();
  return d ? d : undefined;
}

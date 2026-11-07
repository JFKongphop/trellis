// Canonical formatters. Imported by every card/dialog/view so the same
// number renders identically wherever it appears. Pure functions, no React.

/**
 * Truncate (floor) a positive amount to `dp` decimal places. Unlike
 * `toFixed`, this never rounds UP — so a balance reported to the agent or user
 * can never read higher than the real on-chain amount, which would otherwise
 * let a "swap everything" plan request more than the wallet holds.
 */
export function floorToDecimals(n: number, dp = 6): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const f = 10 ** dp;
  return Math.floor(n * f) / f;
}

/**
 * USD formatter.
 * • ≥1: locale-grouped with 2 decimals (or 0 in `compact` mode).
 * • 0.01–1: fixed 2 decimals (`$0.04`).
 * • >0 but < 0.01: rendered as `<$0.01`.
 * • 0 or non-finite: `$0` / `$0.00`.
 */
export function fmtUsd(
  n: number,
  opts: { compact?: boolean } = {},
): string {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1) {
    return `${sign}$${abs.toLocaleString(undefined, {
      maximumFractionDigits: opts.compact ? 0 : 2,
    })}`;
  }
  if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
  if (abs > 0) return `${sign}<$0.01`;
  return "$0.00";
}

/**
 * Abbreviated USD ("$1.2M" / "$420K") for headline TVL-style numbers.
 * Falls back to a fixed 2-decimal under $1K.
 */
export function fmtUsdShort(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Compact non-USD number ("1.5B", "12.3K") — for token supply / counts. */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

/**
 * Token amount formatter. Loose precision: 4 decimals for ≥1, 6 for ≥1e-4,
 * exponential for smaller. Pass `maxFrac` to override the ≥1 ceiling.
 */
export function fmtAmount(n: number, maxFrac = 4): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (Math.abs(n) >= 1) {
    return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
  }
  if (Math.abs(n) >= 0.0001) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return n.toExponential(2);
}

/**
 * Percent formatter (2 decimals). `sign: true` prepends `+` for positive values
 * — used for yield deltas where direction matters.
 */
export function fmtPct(
  n?: number,
  opts: { sign?: boolean } = {},
): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const prefix = opts.sign && n > 0 ? "+" : "";
  return `${prefix}${n.toFixed(2)}%`;
}

/**
 * Per-unit USD price. Goes deeper than fmtUsd for low-priced tokens.
 * 0 / non-finite → em-dash.
 */
export function fmtPriceUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  if (n >= 1)
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

/** Truncate a long address/account id for display: "0x1234…cdef". Leaves short/odd
 *  strings (e.g. alice.near) untouched. */
export function fmtAddress(addr: string, head = 6, tail = 4): string {
  if (!addr.startsWith("0x") || addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** "5m ago" / "3d ago" / falls back to a locale date past ~30d. */
export function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "soon";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Countdown to a future timestamp. "available now" at/past zero. */
export function fmtCountdown(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  if (diff <= 0) return "available now";
  const s = Math.floor(diff / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

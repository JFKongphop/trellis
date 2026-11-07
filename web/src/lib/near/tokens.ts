import "server-only";
import { demoEnabled, demoPrice } from "@/lib/server/demo";

// Token registry for display + agent reads (server-only: the Ref lists are
// ~850 KB and are cached in-process).
//
// Sources (ref-dex-swaps skill, routing-and-apis.md §2, verified live):
//   GET https://indexer.ref.finance/list-token-price → { [id]: { price, symbol, decimal } }
//   GET https://indexer.ref.finance/list-token       → { [id]: { name, symbol, icon, decimals, … } }
//   v2.ref-finance.near get_whitelisted_tokens        → string[] (≈212 ids)
// These are OFF-CHAIN, display-only. Anything that gates money (health
// factor, slippage, Guardian) must use aggregate-oracle.near instead.
// The token list is NOT a safety list: anyone can mint a token called "USDC".
// Identify tokens by account id; "verified" = Ref-whitelisted or well-known.

import { view } from "@/lib/near/rpc";
import { REF_EXCHANGE, TOKENS, WRAP_NEAR } from "@/lib/near/config";

const REF_INDEXER = "https://indexer.ref.finance";

export type TokenMeta = {
  id: string;
  symbol: string;
  name?: string;
  decimals: number;
  icon?: string;
  verified: boolean;
};

type RefPriceRow = { price: string; symbol: string; decimal: number };
type RefTokenRow = {
  name?: string;
  symbol?: string;
  icon?: string | null;
  decimals?: number;
};

type Cached<T> = { at: number; value: T };
const caches = new Map<string, Cached<unknown>>();

async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = caches.get(key) as Cached<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await load();
    caches.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    // Serve stale on upstream failure rather than breaking every read.
    if (hit) return hit.value;
    throw e;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function refPrices(): Promise<Record<string, RefPriceRow>> {
  return cached("ref-prices", 60_000, () =>
    getJson<Record<string, RefPriceRow>>(`${REF_INDEXER}/list-token-price`),
  );
}

export function refTokenList(): Promise<Record<string, RefTokenRow>> {
  return cached("ref-tokens", 60 * 60_000, () =>
    getJson<Record<string, RefTokenRow>>(`${REF_INDEXER}/list-token`),
  );
}

export function refWhitelist(): Promise<Set<string>> {
  return cached("ref-whitelist", 60 * 60_000, async () => {
    const ids = await view<string[]>(REF_EXCHANGE, "get_whitelisted_tokens");
    return new Set(ids ?? []);
  });
}

const WELL_KNOWN = new Set<string>(Object.values(TOKENS));

/** Friendly symbol overrides for ids whose on-chain symbol is ambiguous. */
const SYMBOL_OVERRIDES: Record<string, string> = {
  [TOKENS["USDC.e"]]: "USDC.e",
  [TOKENS["USDT.e"]]: "USDT.e",
};

const metaCache = new Map<string, TokenMeta>();
/** Ids whose metadata failed (spam / non-FT contracts), retried after 1h. */
const metaMisses = new Map<string, number>();

/** Metadata for one token: Ref list first, then `ft_metadata` via RPC. */
export async function tokenMeta(id: string): Promise<TokenMeta | null> {
  const hit = metaCache.get(id);
  if (hit) return hit;
  const miss = metaMisses.get(id);
  if (miss && Date.now() - miss < 60 * 60_000) return null;
  const [list, wl] = await Promise.all([
    refTokenList().catch(() => ({}) as Record<string, RefTokenRow>),
    refWhitelist().catch(() => new Set<string>()),
  ]);
  const verified = WELL_KNOWN.has(id) || wl.has(id);
  const row = list[id];
  let meta: TokenMeta | null = null;
  if (row && typeof row.decimals === "number" && row.symbol) {
    meta = {
      id,
      symbol: SYMBOL_OVERRIDES[id] ?? row.symbol,
      name: row.name,
      decimals: row.decimals,
      icon: row.icon || undefined,
      verified,
    };
  } else {
    try {
      const m = await view<{
        symbol: string;
        name?: string;
        decimals: number;
        icon?: string | null;
      }>(id, "ft_metadata");
      if (m && typeof m.decimals === "number") {
        meta = {
          id,
          symbol: SYMBOL_OVERRIDES[id] ?? m.symbol,
          name: m.name,
          decimals: m.decimals,
          icon: m.icon || undefined,
          verified,
        };
      }
    } catch {
      meta = null;
    }
  }
  if (meta) metaCache.set(id, meta);
  else metaMisses.set(id, Date.now());
  return meta;
}

export async function tokenMetas(
  ids: string[],
): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const m = await tokenMeta(id);
      if (m) out.set(id, m);
    }),
  );
  return out;
}

/** USD prices (display-only) for the given ids; missing ids are omitted. */
export async function pricesUsd(ids: string[]): Promise<Record<string, number>> {
  const all = await refPrices();
  const out: Record<string, number> = {};
  for (const id of ids) {
    const p = Number(all[id]?.price);
    if (Number.isFinite(p) && p > 0) out[id] = p;
  }
  // Demo mode: NEAR follows the sandbox oracle so a simulated crash shows everywhere.
  if (demoEnabled() && ids.includes(WRAP_NEAR)) {
    const d = await demoPrice().catch(() => null);
    if (d) out[WRAP_NEAR] = Number(d.nearE8) / 1e8;
  }
  return out;
}

export type TokenSearchHit = {
  id: string;
  symbol: string;
  name?: string;
  decimals: number;
  priceUsd?: number;
  verified: boolean;
  icon?: string;
};

/**
 * Search by symbol, name or account id. Ranking: exact symbol match, then
 * verified, then has a price, then shorter symbol. Never "autocorrects": the
 * caller gets ranked candidates with their account ids.
 */
export async function searchTokens(
  query: string,
  limit = 8,
): Promise<TokenSearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const [list, prices, wl] = await Promise.all([
    refTokenList(),
    refPrices().catch(() => ({}) as Record<string, RefPriceRow>),
    refWhitelist().catch(() => new Set<string>()),
  ]);
  const hits: (TokenSearchHit & { score: number })[] = [];
  for (const [id, row] of Object.entries(list)) {
    const symbol = SYMBOL_OVERRIDES[id] ?? row.symbol ?? "";
    const name = row.name ?? "";
    const s = symbol.toLowerCase();
    const n = name.toLowerCase();
    let score = -1;
    if (s === q) score = 100;
    else if (id.toLowerCase() === q) score = 95;
    else if (s.startsWith(q)) score = 60;
    else if (n.toLowerCase() === q) score = 55;
    else if (s.includes(q) || n.includes(q)) score = 30;
    else if (id.toLowerCase().includes(q)) score = 20;
    if (score < 0 || typeof row.decimals !== "number") continue;
    const verified = WELL_KNOWN.has(id) || wl.has(id);
    const price = Number(prices[id]?.price);
    const hasPrice = Number.isFinite(price) && price > 0;
    score += verified ? 40 : 0;
    score += WELL_KNOWN.has(id) ? 50 : 0; // native USDC beats bridged lookalikes
    score += hasPrice ? 10 : 0;
    hits.push({
      id,
      symbol,
      name: name || undefined,
      decimals: row.decimals,
      priceUsd: hasPrice ? price : undefined,
      verified,
      icon: row.icon || undefined,
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.symbol.length - b.symbol.length);
  return hits.slice(0, limit).map((h) => ({
    id: h.id,
    symbol: h.symbol,
    name: h.name,
    decimals: h.decimals,
    priceUsd: h.priceUsd,
    verified: h.verified,
    icon: h.icon,
  }));
}

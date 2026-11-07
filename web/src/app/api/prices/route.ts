import { pricesUsd, tokenMetas } from "@/lib/near/tokens";
import { WRAP_NEAR } from "@/lib/near/config";
import { json, errorMessage } from "../_shared";

export const runtime = "nodejs";

/**
 * GET /api/prices?ids=wrap.near,usdt.tether-token.near
 * Display-only USD prices from Ref's indexer (`near` is an alias for wrap.near).
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((s) => (s === "near" ? WRAP_NEAR : s)),
    ),
  ].slice(0, 50);
  if (ids.length === 0) return json({ error: "missing ?ids=" }, 400);
  try {
    const [prices, metas] = await Promise.all([pricesUsd(ids), tokenMetas(ids)]);
    return json(
      {
        source: "indexer.ref.finance (display only)",
        prices: ids.map((id) => ({
          tokenId: id,
          symbol: metas.get(id)?.symbol,
          priceUsd: prices[id],
          verified: metas.get(id)?.verified ?? false,
        })),
      },
      200,
      30,
    );
  } catch (e) {
    return json({ error: `Price read failed: ${errorMessage(e)}` }, 502);
  }
}

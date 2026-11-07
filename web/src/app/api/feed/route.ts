import { replayEnabled, replayFeed } from "@/lib/server/demo-replay";
import { vaultReceipts } from "@/lib/near/vault";
import { tagReceipts, workerConfigured, workerReasons, workerVaults, type WorkerReason } from "@/lib/server/worker";
import type { FeedItem, FeedResponse } from "@/lib/feed";
import { json, errorMessage } from "../_shared";

export const runtime = "nodejs";

const MAX_VAULTS = 25;
const PER_VAULT = 20;
const MAX_ITEMS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 10_000;

let cache: { at: number; body: FeedResponse } | null = null;

/** Recent agent moves across every vault the worker protects. Public data: receipts are on-chain. */
export async function GET() {
  if (replayEnabled()) return json(replayFeed());
  if (cache && Date.now() - cache.at < CACHE_MS) return json(cache.body);
  if (!workerConfigured()) {
    return json({ configured: false, vaults: 0, items: [], stats: { moves: 0, automatic: 0, failed: 0, vaultsActive: 0 }, generatedAt: Date.now() } satisfies FeedResponse);
  }
  try {
    const ids = (await workerVaults()).slice(0, MAX_VAULTS);
    const perVault = await Promise.all(
      ids.map(async (id) => {
        const [receipts, reasons] = await Promise.all([
          vaultReceipts(id, PER_VAULT).catch(() => []),
          workerReasons(id).catch(() => [] as WorkerReason[]),
        ]);
        return tagReceipts(receipts, reasons).map((r): FeedItem => ({ ...r, vault_id: id }));
      }),
    );
    const all = perVault.flat().sort((a, b) => (BigInt(b.timestamp) > BigInt(a.timestamp) ? 1 : -1));
    const since = BigInt(Date.now() - DAY_MS) * BigInt(1e6);
    const recent = all.filter((r) => BigInt(r.timestamp) >= since);
    const body: FeedResponse = {
      configured: true,
      vaults: ids.length,
      items: all.slice(0, MAX_ITEMS),
      stats: {
        moves: recent.length,
        automatic: recent.filter((r) => r.origin === "auto").length,
        failed: recent.filter((r) => r.status === "Failed").length,
        vaultsActive: new Set(recent.map((r) => r.vault_id)).size,
      },
      generatedAt: Date.now(),
    };
    cache = { at: Date.now(), body };
    return json(body);
  } catch (e) {
    return json({ error: `Feed unavailable: ${errorMessage(e)}` }, 502);
  }
}

import { replayEnabled } from "@/lib/server/demo-replay";
import { demoEnabled, demoSend } from "@/lib/server/demo";
import type { NearTx } from "@/lib/near/tx";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Demo-mode stand-in for the wallet: signs as the demo account against the local sandbox. */
export async function POST(req: Request) {
  if (replayEnabled()) {
    // nothing runs in the replay: say so instead of pretending a transaction happened
    const b = (await req.json().catch(() => null)) as { txs?: unknown[] } | null;
    const n = Math.max(1, b?.txs?.length ?? 1);
    const error = "Replay demo: transactions don't run here. Use `pnpm demo:live` (local sandbox) to sign for real.";
    return json({ results: Array.from({ length: n }, () => ({ ok: false, error })) });
  }
  if (!demoEnabled()) return json({ error: "not found" }, 404);
  const b = (await req.json().catch(() => null)) as { txs?: NearTx[] } | null;
  if (!Array.isArray(b?.txs) || b.txs.length === 0 || b.txs.length > 10) return json({ error: "1..10 transactions" }, 400);
  try {
    return json({ results: await demoSend(b.txs) });
  } catch (e) {
    return json({ error: errorMessage(e) }, 502);
  }
}

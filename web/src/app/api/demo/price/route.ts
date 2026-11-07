import { replayEnabled, setReplayPrice } from "@/lib/server/demo-replay";
import { demoEnabled, setDemoPrice } from "@/lib/server/demo";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";

/** Sets the sandbox oracle's NEAR price (e.g. to simulate a crash). */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { nearUsd?: number; step?: number } | null;
  const usd = Number(b?.nearUsd);
  if (!Number.isFinite(usd) || usd <= 0.01 || usd > 1000) return json({ error: "nearUsd must be between 0.01 and 1000" }, 400);
  if (replayEnabled()) return json({ nearUsd: setReplayPrice(usd, typeof b?.step === "number" ? b.step : undefined) });
  if (!demoEnabled()) return json({ error: "not found" }, 404);
  try {
    const r = await setDemoPrice(String(Math.round(usd * 1e8)));
    return json({ nearUsd: Number(r.nearE8) / 1e8 });
  } catch (e) {
    return json({ error: errorMessage(e) }, 502);
  }
}

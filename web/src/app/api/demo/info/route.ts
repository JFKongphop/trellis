import { replayEnabled, replayInfo } from "@/lib/server/demo-replay";
import { demoEnabled, demoPrice, demoState } from "@/lib/server/demo";
import type { DemoInfo } from "@/lib/demo";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";

export async function GET() {
  if (replayEnabled()) return json(replayInfo());
  if (!demoEnabled()) return json({ error: "not found" }, 404);
  try {
    const s = demoState();
    const p = await demoPrice();
    return json({ accountId: s.accountId, vault: s.vault, nearUsd: Number(p.nearE8) / 1e8, startNearUsd: Number(s.startPriceE8) / 1e8, mode: "live" } satisfies DemoInfo);
  } catch (e) {
    return json({ error: `Demo sandbox unreachable: ${errorMessage(e)}` }, 502);
  }
}

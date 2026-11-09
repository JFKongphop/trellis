import { readLendingMarkets } from "@/lib/near/burrow";
import { replayEnabled, replayMarkets } from "@/lib/server/demo-replay";
import { json, errorMessage } from "../_shared";

export const runtime = "nodejs";

/** Rhea Lending markets (APRs, utilization, liquidity, collateral factors). */
export async function GET() {
  if (replayEnabled()) return json({ markets: replayMarkets() });
  try {
    return json({ markets: await readLendingMarkets() }, 200, 30);
  } catch (e) {
    return json({ error: `Markets read failed: ${errorMessage(e)}` }, 502);
  }
}

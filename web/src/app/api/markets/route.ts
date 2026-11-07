import { readLendingMarkets } from "@/lib/near/burrow";
import { json, errorMessage } from "../_shared";

export const runtime = "nodejs";

/** Rhea Lending markets (APRs, utilization, liquidity, collateral factors). */
export async function GET() {
  try {
    return json({ markets: await readLendingMarkets() }, 200, 30);
  } catch (e) {
    return json({ error: `Markets read failed: ${errorMessage(e)}` }, 502);
  }
}

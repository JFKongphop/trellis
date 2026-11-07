import type { IntentsStatus } from "@/lib/oneclick/assets";
import { oneClickStatus, OneClickError } from "@/lib/server/oneclick";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";

/** Status of a 1Click deposit address (display only; balances are the source of truth). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const depositAddress = url.searchParams.get("depositAddress")?.trim() ?? "";
  const memo = url.searchParams.get("depositMemo")?.trim() || undefined;
  if (!depositAddress || depositAddress.length > 128) return json({ error: "depositAddress required" }, 400);
  try {
    const s = await oneClickStatus(depositAddress, memo);
    const d = s.swapDetails ?? {};
    const out: IntentsStatus = {
      status: s.status,
      updatedAt: s.updatedAt,
      amountOutFormatted: d.amountOutFormatted,
      refundedAmountFormatted: d.refundedAmountFormatted,
      refundReason: d.refundReason,
      originTxs: d.originChainTxHashes ?? [],
      nearTxs: d.nearTxHashes ?? [],
    };
    return json(out);
  } catch (e) {
    if (e instanceof OneClickError && e.message === "not_found") {
      // 1Click hasn't indexed a brand-new address yet
      return json({ status: "PENDING_DEPOSIT", originTxs: [], nearTxs: [] } satisfies IntentsStatus);
    }
    return json({ error: errorMessage(e) }, 502);
  }
}

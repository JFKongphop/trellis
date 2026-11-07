import { oneClickSubmitDeposit } from "@/lib/server/oneclick";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";

/** Optional speed-up: the user pastes their origin-chain tx hash. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { txHash?: string; depositAddress?: string } | null;
  const txHash = String(b?.txHash ?? "").trim();
  const depositAddress = String(b?.depositAddress ?? "").trim();
  if (!/^[0-9a-zA-Z]{20,128}$/.test(txHash.replace(/^0x/, "")) || !depositAddress) {
    return json({ error: "Paste the transaction hash from your wallet." }, 400);
  }
  try {
    await oneClickSubmitDeposit(txHash, depositAddress);
    return json({ ok: true });
  } catch (e) {
    return json({ error: errorMessage(e) }, 502);
  }
}

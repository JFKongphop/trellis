import { replayEnabled, replayVaultState } from "@/lib/server/demo-replay";
import { readBalances } from "@/lib/near/balances";
import { readLendingPosition } from "@/lib/near/burrow";
import {
  vaultPolicy,
  vaultProtocolsReady,
  vaultReceipts,
  vaultRemainingDaily,
  vaultStatus,
  vaultTokens,
} from "@/lib/near/vault";
import { tagReceipts, workerConfigured, workerReasons, type WorkerReason } from "@/lib/server/worker";
import { json, parseAccount, errorMessage } from "../../_shared";

export const runtime = "nodejs";
// `?id=` instead of a [id] path segment: dynamic segments make Next dev start a worker process
// per request (static paths), which piled up into many GB when it failed.

/** Everything the vault dashboard needs, in one read. */
export async function GET(req: Request) {
  const vaultId = parseAccount(new URL(req.url).searchParams.get("id") ?? "");
  if (!vaultId) return json({ error: "Invalid vault id" }, 400);
  if (replayEnabled()) return json(replayVaultState(vaultId));
  try {
    const status = await vaultStatus(vaultId);
    if (!status) return json({ error: `${vaultId} is not a Trellis vault` }, 404);
    const [policy, tokens, rawReceipts, balances, position, protocolsReady, reasons] = await Promise.all([
      vaultPolicy(vaultId),
      vaultTokens(vaultId),
      vaultReceipts(vaultId, 30),
      readBalances(vaultId),
      readLendingPosition(vaultId),
      vaultProtocolsReady(vaultId),
      // optional: tells automatic actions apart from owner-approved ones
      workerConfigured() ? workerReasons(vaultId).catch(() => [] as WorkerReason[]) : Promise.resolve([] as WorkerReason[]),
    ]);
    const receipts = tagReceipts(rawReceipts, reasons);
    const remaining: Record<string, string> = {};
    await Promise.all(
      (policy?.daily_cap ?? []).map(async ([t]) => {
        remaining[t] = await vaultRemainingDaily(vaultId, t);
      }),
    );
    return json({ vaultId, status, policy, tokens, receipts, remaining, balances, position, protocolsReady });
  } catch (e) {
    return json({ error: `Vault read failed: ${errorMessage(e)}` }, 502);
  }
}

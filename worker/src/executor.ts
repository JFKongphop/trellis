// Runs one agent action end to end: send → (if submitted) wait → sync_position → final outcome.
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.ts";
import { actionOutcome, agentCall } from "./near.ts";
import { log, recordReasoning, recordTx } from "./store.ts";

export type StepResult = { state: "settled" | "failed"; amountOut?: string; note?: string; txHashes: string[] };

export async function runAction(
  vaultId: string,
  method: string,
  args: Record<string, unknown>,
  reasoning: Record<string, unknown>,
): Promise<StepResult> {
  const reasonHash = recordReasoning({ vault: vaultId, method, args, ...reasoning });
  const txHashes: string[] = [];
  try {
    const first = await agentCall(vaultId, method, { ...args, reason_hash: reasonHash });
    txHashes.push(first.txHash);
    recordTx(reasonHash, first.txHash);
    let out = actionOutcome(first);
    log("action_sent", { vault: vaultId, method, tx: first.txHash, state: out.state, note: out.note, reasonHash });
    if (out.state === "submitted") {
      // The vault needs ≥5 s before sync_position, and only declares a borrow / withdraw "not executed"
      // after 3 min (SYNC_FINAL_NS), so keep syncing until then.
      const giveUpAt = Date.now() + config.syncFinalMs;
      while (out.state === "submitted" && Date.now() < giveUpAt) {
        await sleep(config.syncDelayMs);
        try {
          const sync = await agentCall(vaultId, "sync_position", {});
          txHashes.push(sync.txHash);
          const o = actionOutcome(sync);
          if (o.state !== "failed" || o.note !== "no_vault_event") out = o; // no event = still pending
          log("action_synced", { vault: vaultId, method, tx: sync.txHash, state: out.state, note: out.note });
        } catch (e) {
          // e.g. ERR_SYNC_TOO_EARLY or a transient RPC error: wait and retry
          log("sync_retry", { vault: vaultId, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
        }
      }
      if (out.state === "submitted") return { state: "failed", note: "sync_pending_timeout", txHashes };
    }
    return { state: out.state === "settled" ? "settled" : "failed", amountOut: out.amountOut, note: out.note, txHashes };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("action_error", { vault: vaultId, method, error: msg.slice(0, 300) });
    return { state: "failed", note: msg.slice(0, 200), txHashes };
  }
}

// RPC access. Reads use failover; sends use ONE JsonRpcProvider (FailoverRpcProvider hides InvalidNonce,
// which disables near-api-js's nonce retry; see near-frontend/near-api-js.md).
import { Account, FailoverRpcProvider, JsonRpcProvider, actions, teraToGas, getTransactionLastResult } from "near-api-js";
import { config } from "./config.ts";
import { signerFor } from "./keys.ts";

export const readProvider = new FailoverRpcProvider(
  [config.rpcUrl, ...config.rpcFallbacks].map((url) => new JsonRpcProvider({ url })),
);
const sendProvider = new JsonRpcProvider({ url: config.rpcUrl }, { retries: 3, wait: 500, backoff: 1.5 });
// One Account per process: it holds the NonceManager (nonces are per key, so vaults never collide).
const agent = new Account(config.agentId, sendProvider);

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await readProvider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });
  return r as unknown as T;
}

export type NepEvent = { standard: string; version: string; event: string; data: any; emitter: string };

export type CallResult = {
  txHash: string;
  /** trellis_vault events emitted by the vault itself (other emitters are ignored). */
  events: NepEvent[];
  failedReceipts: number;
  value: unknown;
};

/** Agent call to a vault with that vault's function-call key. No deposit (FC keys can't attach any). */
export async function agentCall(vaultId: string, method: string, args: Record<string, unknown>): Promise<CallResult> {
  const outcome = await agent.signAndSendTransaction({
    receiverId: vaultId,
    actions: [actions.functionCall(method, args, teraToGas(String(config.agentGasTgas) as `${number}`), 0n)],
    signer: signerFor(config.agentKeySeed, vaultId),
    waitUntil: "EXECUTED_OPTIMISTIC",
    throwOnFailure: true,
  });
  const events: NepEvent[] = [];
  let failedReceipts = 0;
  for (const r of outcome.receipts_outcome) {
    const st = r.outcome.status as unknown;
    if (st && typeof st === "object" && "Failure" in st) failedReceipts++;
    if (r.outcome.executor_id !== vaultId) continue; // trust only the vault's own logs
    for (const log of r.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const ev = JSON.parse(log.slice("EVENT_JSON:".length));
        if (ev.standard === "trellis_vault") events.push({ ...ev, emitter: r.outcome.executor_id });
      } catch {
        /* not JSON */
      }
    }
  }
  let value: unknown = undefined;
  try {
    value = getTransactionLastResult(outcome);
  } catch {
    /* empty result */
  }
  return { txHash: outcome.transaction_outcome.id, events, failedReceipts, value };
}

/** Outcome of one agent action, judged from the vault's own events (the vault settles inside callbacks). */
export function actionOutcome(r: CallResult): { state: "settled" | "submitted" | "failed"; note?: string; amountOut?: string } {
  const pick = (name: string) => r.events.find((e) => e.event === name);
  const failed = pick("action_failed") ?? pick("policy_violation");
  if (failed) {
    const d = Array.isArray(failed.data) ? failed.data[0] : failed.data;
    return { state: "failed", note: d?.note ?? d?.rule ?? failed.event };
  }
  const settled = pick("action_settled");
  if (settled) return { state: "settled", amountOut: settled.data?.[0]?.amount_out, note: settled.data?.[0]?.note || undefined };
  if (pick("action_submitted")) return { state: "submitted" };
  return { state: "failed", note: "no_vault_event" };
}

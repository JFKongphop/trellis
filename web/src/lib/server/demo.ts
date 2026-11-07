import "server-only";

// Server side of demo mode. Only active when DEMO_MODE=1 (set by demo/run.mjs). The demo
// account's key lives in DEMO_STATE_FILE (written by the sandbox launcher) and never reaches
// the browser; it is a throwaway sandbox key.
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPairSigner, actions, type FinalExecutionOutcome, type KeyPairString } from "near-api-js";
import { outcomeResult, type TxResult } from "@/lib/near/outcome";
import type { NearTx } from "@/lib/near/tx";

export type DemoState = {
  rpcUrl: string;
  accountId: string;
  secretKey: string;
  factory: string;
  agent: string;
  vault: string;
  workerUrl: string;
  workerToken: string;
  controlUrl: string;
  startPriceE8: string;
};

export const demoEnabled = () => process.env.DEMO_MODE === "1" && !!process.env.DEMO_STATE_FILE;

export function demoState(): DemoState {
  if (!demoEnabled()) throw new Error("demo mode is off");
  return JSON.parse(readFileSync(process.env.DEMO_STATE_FILE!, "utf8")) as DemoState;
}

let account: { key: string; acc: Account } | null = null;
function demoAccount(s: DemoState): Account {
  if (!account || account.key !== s.secretKey) {
    const provider = new JsonRpcProvider({ url: s.rpcUrl }, { retries: 3, wait: 300, backoff: 1.5 });
    const signer = KeyPairSigner.fromSecretKey(s.secretKey as KeyPairString);
    account = { key: s.secretKey, acc: new Account(s.accountId, provider, signer) };
  }
  return account.acc;
}

/** Signs and sends like a wallet: in order, stopping after the first failure. */
export async function demoSend(txs: NearTx[]): Promise<TxResult[]> {
  const s = demoState();
  const acc = demoAccount(s);
  const out: TxResult[] = [];
  for (const tx of txs) {
    try {
      const outcome = await acc.signAndSendTransaction({
        receiverId: tx.receiverId,
        actions: tx.actions.map((a) =>
          a.type === "Transfer"
            ? actions.transfer(BigInt(a.params.deposit))
            : actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit)),
        ),
        waitUntil: "EXECUTED_OPTIMISTIC",
        throwOnFailure: false,
      });
      // the RPC response has the same fields outcomeResult reads
      const r = outcomeResult(outcome as unknown as FinalExecutionOutcome);
      out.push(r);
      if (!r.ok) break;
    } catch (e) {
      out.push({ ok: false, error: (e as Error).message.slice(0, 240) });
      break;
    }
  }
  return out;
}

async function control<T>(path: string, init: RequestInit = {}): Promise<T> {
  const s = demoState();
  const r = await fetch(`${s.controlUrl}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `control ${r.status}`);
  return j;
}

export const demoPrice = () => control<{ nearE8: string }>("/state");
export const setDemoPrice = (nearE8: string) =>
  control<{ nearE8: string }>("/price", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nearE8 }) });

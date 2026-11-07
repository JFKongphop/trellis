import "server-only";

// Client for the Trellis worker (trellis/worker). WORKER_URL and
// WORKER_API_TOKEN are server-only; the token never reaches the browser.

import type { VaultCall } from "@/lib/ai/plan-types";
import type { VaultReceipt } from "@/lib/near/vault";

export type WorkerStepStatus = "pending" | "running" | "done" | "failed";
export type WorkerPlan = {
  planId: string;
  vaultId: string;
  status: "queued" | "running" | "done" | "failed";
  steps: { label: string; method: string; status: WorkerStepStatus; txHash?: string; note?: string }[];
  error?: string;
};

export class WorkerUnavailable extends Error {}

function cfg() {
  const url = process.env.WORKER_URL?.replace(/\/+$/, "");
  const token = process.env.WORKER_API_TOKEN;
  if (!url || !token) throw new WorkerUnavailable("The Trellis worker isn't configured (WORKER_URL / WORKER_API_TOKEN).");
  return { url, token };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, token } = cfg();
  let r: Response;
  try {
    r = await fetch(`${url}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new WorkerUnavailable(`Worker unreachable: ${(e as Error).message}`);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`Worker ${r.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export const workerSubmitPlan = (p: {
  planId: string;
  vaultId: string;
  owner: string;
  steps: VaultCall[];
  reasoning: string;
}) => call<{ planId: string }>("/plans", { method: "POST", body: JSON.stringify(p) });

export const workerGetPlan = (planId: string) =>
  call<WorkerPlan>(`/plans/${encodeURIComponent(planId)}`);

export const workerRegisterVault = (vaultId: string, owner: string) =>
  call<unknown>("/vaults", { method: "POST", body: JSON.stringify({ vaultId, owner }) });

export const workerConfigured = () => !!process.env.WORKER_URL && !!process.env.WORKER_API_TOKEN;

export type WorkerReason = {
  hash: string;
  source: "auto_protection" | "owner_approved_plan" | "other";
  why: string;
  hfBefore: string | null;
  at: string;
  txHash?: string;
};

export const workerReasons = (vaultId: string) =>
  call<{ reasons: WorkerReason[] }>(`/vaults/${encodeURIComponent(vaultId)}/reasons`).then((r) => r.reasons ?? []);

/** Vault ids the worker protects (public on-chain ids; no owners). */
export const workerVaults = () => call<{ vaults: string[] }>("/vaults").then((r) => r.vaults ?? []);

/** Marks receipts the worker started on its own ("auto") or from an owner-approved plan ("plan"). */
export function tagReceipts(receipts: VaultReceipt[], reasons: WorkerReason[]): VaultReceipt[] {
  const byHash = new Map(reasons.map((r) => [r.hash, r]));
  return receipts.map((r) => {
    const why = byHash.get(r.reason_hash);
    if (!why) return r;
    const tx = why.txHash ? { tx_hash: why.txHash } : {};
    if (why.source === "auto_protection") return { ...r, ...tx, origin: "auto" as const, why: why.why, hf_before_bps: why.hfBefore };
    if (why.source === "owner_approved_plan") return { ...r, ...tx, origin: "plan" as const };
    return { ...r, ...tx };
  });
}

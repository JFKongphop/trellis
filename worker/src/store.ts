// Small JSON-file state store (vault registry, deleverage sessions, plans, circuit breakers).
// Writes are atomic (write temp + rename). Fine for one worker process.
import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.ts";

export type Stage = "withdraw" | "swap" | "repay";
export type Session = { stage: Stage; collateralToken: string; debtToken: string; amount: string; startedAt: number; cycles: number };
export type StepStatus = "pending" | "running" | "done" | "failed";
export type PlanStep = { label: string; method: string; args: Record<string, unknown>; status: StepStatus; txHash?: string; note?: string };
export type Plan = {
  planId: string;
  vaultId: string;
  owner: string;
  reasoning: string;
  status: "queued" | "running" | "done" | "failed";
  steps: PlanStep[];
  error?: string;
  createdAt: number;
};
export type VaultEntry = { owner: string; addedAt: number; failures: number; breakerOpen: boolean };

type State = { vaults: Record<string, VaultEntry>; sessions: Record<string, Session>; plans: Record<string, Plan> };

mkdirSync(config.dataDir, { recursive: true });
const FILE = join(config.dataDir, "state.json");
const LOG = join(config.dataDir, "reasoning.jsonl");

function load(): State {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return { vaults: {}, sessions: {}, plans: {} };
  }
}

export const state: State = load();

export function save() {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, FILE);
}

/** What the web app may show about an action: who started it and why (no args, no plan text). */
export type ReasonSummary = {
  hash: string;
  source: "auto_protection" | "owner_approved_plan" | "other";
  why: string;
  /** HF (bps) the worker saw before an automatic action. */
  hfBefore: string | null;
  at: string;
  /** Transaction that carried the action (set once it was sent). */
  txHash?: string;
};

const REASONS_PER_VAULT = 200;
const reasons = new Map<string, ReasonSummary[]>();
const byHash = new Map<string, ReasonSummary>();

function indexReason(hash: string, r: Record<string, unknown>) {
  const vault = typeof r.vault === "string" ? r.vault : null;
  if (!vault) return;
  const source = r.source === "auto_protection" || r.source === "owner_approved_plan" ? r.source : "other";
  const why = String(r.why ?? r.step ?? r.method ?? "").slice(0, 200);
  const list = reasons.get(vault) ?? [];
  const summary: ReasonSummary = { hash, source, why, hfBefore: typeof r.hf === "string" ? r.hf : null, at: String(r.at ?? "") };
  list.push(summary);
  byHash.set(hash, summary);
  if (list.length > REASONS_PER_VAULT) for (const old of list.splice(0, list.length - REASONS_PER_VAULT)) byHash.delete(old.hash);
  reasons.set(vault, list);
}

// rebuild the index from the log on start
try {
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const { hash, record, tx } = JSON.parse(line);
      if (typeof hash !== "string") continue;
      if (record && typeof record === "object") indexReason(hash, record);
      else if (typeof tx === "string") {
        const r = byHash.get(hash);
        if (r) r.txHash = tx;
      }
    } catch {
      // skip a torn line
    }
  }
} catch {
  // no log yet
}

/** Newest last. */
export const reasonsFor = (vaultId: string): ReasonSummary[] => reasons.get(vaultId) ?? [];

/** Remember which transaction carried the action with this reason hash (for explorer links). */
export function recordTx(hash: string, txHash: string) {
  const r = byHash.get(hash);
  if (!r || r.txHash) return;
  r.txHash = txHash;
  appendFileSync(LOG, JSON.stringify({ hash, tx: txHash }) + "\n");
}

/** Appends a reasoning record and returns its sha256 (hex) — this is the vault's `reason_hash`. */
export function recordReasoning(record: Record<string, unknown>): string {
  const line = JSON.stringify({ ...record, at: new Date().toISOString() });
  const hash = createHash("sha256").update(line).digest("hex");
  const parsed = JSON.parse(line);
  appendFileSync(LOG, JSON.stringify({ hash, record: parsed }) + "\n");
  indexReason(hash, parsed);
  return hash;
}

export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

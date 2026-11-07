// Plan types shared by the plan builders (server), the plan card and the
// Guardian (client). Wallet mode produces NEAR transactions the user signs;
// vault mode produces `agent_*` calls the worker sends after the owner approves.

import type { NearTx } from "@/lib/near/tx";

/** One Guardian risk row ({ title, note, level }), from the LLM or deterministic checks. */
export type PlanRisk = {
  title: string;
  note: string;
  level: "pass" | "flag" | "block";
};

export type GuardianRow = PlanRisk & { id: string; source: "check" | "agent" };

export type ResolvedStep = {
  id: string;
  kind: string;
  /** Plain-English line, e.g. "Swap 10 NEAR → ≥ 53.2 USDC on Ref (pool 4512)". */
  label: string;
  tokenIn?: string;
  amountIn?: number;
  tokenOut?: string;
  /** Expected output (quote) and guaranteed minimum (after slippage). */
  amountOut?: number;
  minOut?: number;
  /** Indexes into `txs` (wallet mode) or `calls` (vault mode). */
  refs: number[];
  /** For the money-flow graph: Ref pool of a swap, recipient of a send, and the earlier step whose output this one uses. */
  pool?: number;
  to?: string;
  fromStep?: string;
};

export type WalletPlan = {
  mode: "wallet";
  accountId: string;
  steps: ResolvedStep[];
  txs: NearTx[];
  guardian: GuardianRow[];
  blocked: boolean;
  summary: string;
  healthBefore?: number | null;
  healthAfter?: number | null;
  createdAt: number;
};

export type VaultCall = {
  method: string;
  /** Args WITHOUT reason_hash (the worker adds it). */
  args: Record<string, unknown>;
  label: string;
};

export type VaultPlan = {
  mode: "vault";
  vaultId: string;
  owner: string;
  steps: ResolvedStep[];
  calls: VaultCall[];
  guardian: GuardianRow[];
  blocked: boolean;
  summary: string;
  healthBefore?: number | null;
  healthAfter?: number | null;
  createdAt: number;
};

export type BuiltPlan = WalletPlan | VaultPlan;

/** Agent methods the web app may ask the worker to run (vault-spec §5.3). */
export const AGENT_METHODS = [
  "agent_wrap_near",
  "agent_supply",
  "agent_repay",
  "agent_borrow",
  "agent_withdraw_collateral",
  "agent_withdraw_supplied",
  "agent_swap_ref",
] as const;
export type AgentMethod = (typeof AGENT_METHODS)[number];

/** Exact arg keys per method (reason_hash is added by the worker). */
export const AGENT_ARG_KEYS: Record<AgentMethod, string[]> = {
  agent_wrap_near: ["amount"],
  agent_supply: ["token", "amount"],
  agent_repay: ["token", "amount"],
  agent_borrow: ["token", "amount"],
  agent_withdraw_collateral: ["token", "amount", "deleverage"],
  agent_withdraw_supplied: ["token"],
  agent_swap_ref: ["pool_id", "token_in", "token_out", "amount_in"],
};

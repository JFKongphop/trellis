// Rules form ⇄ on-chain Policy (contracts/vault/src/policy.rs). Presets from
// frontend-spec §3.3 and rhea-burrow-lending strategies §6:
//   Careful  = ~1.5x, HF ≥ 1.7    Balanced = ~1.8x, HF ≥ 1.5
// Contract validation (keep in sync): slippage 1..=500 bps, min HF ≥ 1.1,
// floor ≥ 1.05, floor < trigger, trigger + 0.05 ≤ min HF, per-action ≤ daily,
// reserve ≥ 0.1 NEAR, Intents spread 1..=slippage bps.

import { REF_POOLS, TOKENS, WRAP_NEAR } from "@/lib/near/config";
import { fromBase, toBase } from "@/lib/near/tx";
import type { VaultPolicy } from "@/lib/near/vault";

export const VAULT_TOKENS = [
  { id: WRAP_NEAR, symbol: "wNEAR", decimals: 24 },
  { id: TOKENS.USDC, symbol: "USDC", decimals: 6 },
  { id: TOKENS.USDT, symbol: "USDT", decimals: 6 },
] as const;

export type PresetId = "careful" | "balanced" | "custom";

export type RulesForm = {
  preset: PresetId;
  /** Advisory target the agent aims for (not enforced on-chain; HF is). */
  targetLeverage: number;
  minHf: number;
  deleverageTrigger: number;
  emergencyFloor: number;
  maxSlippagePct: number;
  tokens: string[];
  perAction: Record<string, number>;
  daily: Record<string, number>;
  enableIntents: boolean;
  /** 0 = no expiry. */
  agentExpiryDays: number;
};

const baseCaps = {
  perAction: { [WRAP_NEAR]: 100, [TOKENS.USDC]: 500, [TOKENS.USDT]: 500 },
  daily: { [WRAP_NEAR]: 500, [TOKENS.USDC]: 2000, [TOKENS.USDT]: 2000 },
};

export const PRESETS: Record<Exclude<PresetId, "custom">, RulesForm> = {
  careful: {
    preset: "careful",
    targetLeverage: 1.5,
    minHf: 1.7,
    deleverageTrigger: 1.5,
    emergencyFloor: 1.2,
    maxSlippagePct: 0.5,
    tokens: [WRAP_NEAR, TOKENS.USDC],
    ...baseCaps,
    enableIntents: false,
    agentExpiryDays: 30,
  },
  balanced: {
    preset: "balanced",
    targetLeverage: 1.8,
    minHf: 1.5,
    deleverageTrigger: 1.35,
    emergencyFloor: 1.15,
    maxSlippagePct: 1,
    tokens: [WRAP_NEAR, TOKENS.USDC],
    ...baseCaps,
    enableIntents: false,
    agentExpiryDays: 30,
  },
};

const bps = (x: number) => Math.round(x * 10000);
const dec = (id: string) => VAULT_TOKENS.find((t) => t.id === id)?.decimals ?? 24;
const sym = (id: string) => VAULT_TOKENS.find((t) => t.id === id)?.symbol ?? id;

/** Problems the contract would reject (shown under the form before signing). */
export function validateRules(f: RulesForm): string[] {
  const e: string[] = [];
  if (f.tokens.length === 0) e.push("Allow at least one token.");
  if (f.maxSlippagePct <= 0 || f.maxSlippagePct > 5) e.push("Max slippage must be between 0.01% and 5%.");
  if (f.minHf < 1.1) e.push("Minimum health factor must be at least 1.1.");
  if (f.emergencyFloor < 1.05) e.push("Emergency floor must be at least 1.05.");
  if (!(f.emergencyFloor < f.deleverageTrigger && bps(f.deleverageTrigger) + 500 <= bps(f.minHf))) {
    e.push("Need emergency floor < deleverage trigger, and the trigger at least 0.05 below the minimum health factor.");
  }
  for (const t of f.tokens) {
    const p = f.perAction[t] ?? 0;
    const d = f.daily[t] ?? 0;
    if (!(p > 0) || !(d > 0)) e.push(`${sym(t)}: limits must be above 0.`);
    else if (p > d) e.push(`${sym(t)}: per-action limit can't exceed the daily limit.`);
  }
  if (f.enableIntents) e.push("NEAR Intents routing needs a verified 1Click quote key; leave it off for now.");
  return e;
}

export function rulesToPolicy(f: RulesForm): VaultPolicy {
  const pools = REF_POOLS.filter((p) => p.tokens.every((t) => f.tokens.includes(t))).map((p) => p.id);
  return {
    allowed_tokens: [...f.tokens],
    allowed_ref_pools: pools,
    per_action_cap: f.tokens.map((t) => [t, toBase(f.perAction[t] ?? 0, dec(t)).toString()]),
    daily_cap: f.tokens.map((t) => [t, toBase(f.daily[t] ?? 0, dec(t)).toString()]),
    max_slippage_bps: Math.round(f.maxSlippagePct * 100),
    // Intents quotes must price within 0.5% of the oracle (never looser than the slippage limit)
    max_intents_spread_bps: Math.min(50, Math.round(f.maxSlippagePct * 100)),
    min_health_factor_bps: bps(f.minHf),
    deleverage_trigger_bps: bps(f.deleverageTrigger),
    emergency_floor_bps: bps(f.emergencyFloor),
    max_price_age_sec: 60,
    max_price_conf_bps: 100,
    burrow_enabled: true,
    ref_enabled: pools.length > 0,
    // Agent Intents routing stays off until quote-signature verification is wired (trellis-vault rule 4).
    intents_enabled: false,
    intents_quote_pubkey: null,
    min_near_reserve: toBase("0.5", 24).toString(),
    max_storage_spend: toBase("1", 24).toString(),
  };
}

export function policyToRules(p: VaultPolicy): RulesForm {
  const cap = (list: [string, string][]) =>
    Object.fromEntries(list.map(([t, v]) => [t, fromBase(v, dec(t))]));
  return {
    preset: "custom",
    targetLeverage: 1.8,
    minHf: p.min_health_factor_bps / 10000,
    deleverageTrigger: p.deleverage_trigger_bps / 10000,
    emergencyFloor: p.emergency_floor_bps / 10000,
    maxSlippagePct: p.max_slippage_bps / 100,
    tokens: [...p.allowed_tokens],
    perAction: cap(p.per_action_cap),
    daily: cap(p.daily_cap),
    enableIntents: p.intents_enabled,
    agentExpiryDays: 30,
  };
}

/** Plain-language summary shown under the form (frontend-spec §3.3). */
export function rulesSummary(f: RulesForm): string {
  const toks = f.tokens.map(sym).join(", ");
  const caps = f.tokens
    .map((t) => `${f.perAction[t] ?? 0} ${sym(t)} per action / ${f.daily[t] ?? 0} per day`)
    .join("; ");
  return (
    `The agent may use ${toks} on Rhea Lending and Ref, aiming for about ${f.targetLeverage}x, ` +
    `and can never push your health factor below ${f.minHf.toFixed(2)} ` +
    `(it starts deleveraging below ${f.deleverageTrigger.toFixed(2)}). ` +
    `Spending limits: ${caps}. Swaps accept at most ${f.maxSlippagePct}% worse than the oracle price. ` +
    `Funds can only go to Rhea Lending, Ref, or back to you.` +
    (f.agentExpiryDays > 0 ? ` The agent's permission ends after ${f.agentExpiryDays} days.` : "")
  );
}

/** Prefill codec for links like /vault/setup?rules=… (proposePolicy). */
export const encodeRules = (f: RulesForm) =>
  typeof window === "undefined"
    ? Buffer.from(JSON.stringify(f)).toString("base64url")
    : btoa(unescape(encodeURIComponent(JSON.stringify(f)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function decodeRules(s: string | null): RulesForm | null {
  if (!s) return null;
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const f = JSON.parse(decodeURIComponent(escape(atob(b64)))) as RulesForm;
    if (!Array.isArray(f.tokens) || typeof f.minHf !== "number") return null;
    return { ...PRESETS.balanced, ...f, tokens: f.tokens.filter((t) => VAULT_TOKENS.some((v) => v.id === t)) };
  } catch {
    return null;
  }
}

import "server-only";

// Stateless approval token for vault plans: the preview route signs exactly
// the calls the owner saw; /api/vault/approve accepts only that token, only
// for that owner, only for 5 minutes (frontend-spec §7 "Security").

import { randomUUID } from "node:crypto";
import { signServerData, verifyServerData } from "@/lib/server/auth";
import type { VaultCall } from "@/lib/ai/plan-types";

export const PLAN_TTL_MS = 5 * 60 * 1000;

export type PlanClaims = {
  planId: string;
  vaultId: string;
  owner: string;
  calls: VaultCall[];
  reasoning: string;
  exp: number;
};

export function signPlan(c: Omit<PlanClaims, "planId" | "exp">): { token: string; claims: PlanClaims } {
  const claims: PlanClaims = { ...c, planId: randomUUID(), exp: Date.now() + PLAN_TTL_MS };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${body}.${signServerData(`plan|${body}`)}`, claims };
}

export function verifyPlan(token: string): PlanClaims | { error: string } {
  const [body, sig] = (token ?? "").split(".");
  if (!body || !sig || !verifyServerData(`plan|${body}`, sig)) return { error: "invalid plan token" };
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString()) as PlanClaims;
    if (Date.now() > c.exp) return { error: "plan expired (5 min); ask the agent to rebuild it" };
    return c;
  } catch {
    return { error: "invalid plan token" };
  }
}

"use client";

// Full plans by tool-call id. The model only gets a pruned summary of a plan
// (tool output); the card needs the transactions / approval token, which stay
// in the browser. Lost on reload.

import type { BuiltPlan } from "@/lib/ai/plan-types";
import type { VaultApproval } from "@/components/parts/near-plan-card";

export const planCache = new Map<string, { plan: BuiltPlan; approval?: VaultApproval }>();

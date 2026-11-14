// Pricing for the selectable NEAR AI Cloud models (USD per 1M tokens, from the
// live GET https://cloud-api.near.ai/v1/models list, 2026-10-22). Pure data +
// math, safe for client and server. Re-check before the demo: ids change.

export const MODEL_PRICING = {
  "Qwen/Qwen3.6-35B-A3B-FP8": {
    inputPer1M: 0.17,
    cachedInputPer1M: 0.056,
    outputPer1M: 1.1,
    name: "Trellis",
    description:
      "Qwen 3.6 35B in a NEAR AI TEE. Fast, with thinking off.",
    isDefault: true,
  },
  // GLM 5.3 Flash was removed on 2026-11-15: on NEAR AI Cloud it ignored "thinking off" and looped
  // its hidden reasoning for minutes ("Done. Good. Done…").
} as Record<
  string,
  {
    inputPer1M: number;
    cachedInputPer1M: number;
    outputPer1M: number;
    name: string;
    description: string;
    isDefault?: boolean;
  }
>;

export type SelectableModel = {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
};

/** The user-selectable chat models (every entry in the pricing table). */
export function selectableModels(): SelectableModel[] {
  return Object.entries(MODEL_PRICING).map(([id, m]) => ({
    id,
    name: m.name,
    description: m.description,
    isDefault: !!m.isDefault,
  }));
}

/** The id flagged `isDefault` (falls back to the first listed model). */
export function defaultModelId(): string {
  const ids = Object.keys(MODEL_PRICING);
  return ids.find((id) => MODEL_PRICING[id]?.isDefault) ?? ids[0];
}

/** Whether an id is a known/allowed model (guards the chat route). */
export function isKnownModel(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICING, id);
}

/** Computes USD cost from a `LanguageModelUsage`-shaped object. */
export function computeMessageCostAndModelName(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  model: string;
}) {
  const totalInput = usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const fresh = Math.max(0, totalInput - cached);
  const output = usage.outputTokens ?? 0;
  const p = MODEL_PRICING[usage.model];
  return {
    cost:
      (fresh / 1_000_000) * (p?.inputPer1M ?? 0) +
      (cached / 1_000_000) * (p?.cachedInputPer1M ?? 0) +
      (output / 1_000_000) * (p?.outputPer1M ?? 0),
    name: p?.name ?? usage.model,
  };
}

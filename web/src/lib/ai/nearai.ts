import "server-only";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// NEAR AI Cloud (OpenAI-compatible) via @ai-sdk/openai-compatible@2.0.87, the
// AI-SDK-v6 line (dist-tag `ai-v6`; 3.x targets ai@7). See the
// near-ai-agent-infra skill, near-ai-cloud.md §1.

export const NEARAI_BASE_URL = "https://cloud-api.near.ai/v1";

export const nearaiConfigured = () => !!process.env.NEARAI_API_KEY;

const nearai = createOpenAICompatible({
  name: "nearai", // also the providerOptions key: providerOptions.nearai
  baseURL: NEARAI_BASE_URL,
  apiKey: process.env.NEARAI_API_KEY ?? "",
  includeUsage: true, // stream_options.include_usage → token usage on streams
  supportsStructuredOutputs: true,
});

/** Default chat model. Override with NEARAI_MODEL. */
export const DEFAULT_MODEL = process.env.NEARAI_MODEL || "z-ai/glm-5.3-flash";

// NEAR AI Cloud has no gateway-side model fallback (unlike OpenRouter). The
// user can switch model in the input; automatic retry on a second model is a
// TODO (catch the first streamText error and re-run with the next id).

type ModelRuntime = { thinking: boolean; maxOutputTokens: number };
const MODEL_RUNTIME: Record<string, ModelRuntime> = {
  // Thinking off: hidden tokens eat the output budget and truncate tool args.
  "z-ai/glm-5.3-flash": { thinking: false, maxOutputTokens: 8192 },
  "Qwen/Qwen3.6-35B-A3B-FP8": { thinking: false, maxOutputTokens: 8192 },
};
export const modelRuntime = (id: string): ModelRuntime =>
  MODEL_RUNTIME[id] ?? { thinking: false, maxOutputTokens: 8192 };

/** Callers must validate `id` (isKnownModel) first. */
export const chatModel = (id: string) => nearai.chatModel(id);

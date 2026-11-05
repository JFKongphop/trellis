# NEAR AI Cloud from the Vercel AI SDK (+ verified responses)

Verified 2026-10-22 against docs.near.ai and the live `GET https://cloud-api.near.ai/v1/models`.
No API key was used; anything that needs a key to observe is marked [VERIFY].

## 1. Minimal swap in `web/src/lib/ai/openrouter.ts`

Sprout today: `@openrouter/ai-sdk-provider` + `ai@^6.0.182`, per-model `reasoning` via
`providerOptions.openrouter`, and OpenRouter-side fallback (`models: aiModels`).

```bash
pnpm -C web add @ai-sdk/openai-compatible@ai-v6     # resolves 2.0.87 (provider spec v3, matches ai@6)
# NOT @latest (3.0.75 → @ai-sdk/provider 4.x, for ai@7)
```

```ts
// web/src/lib/ai/nearai.ts  (replaces openrouter.ts; keep the exported names so callers don't change)
import "server-only";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const apiKey = process.env.NEARAI_API_KEY;
if (!apiKey) console.warn("[ai] NEARAI_API_KEY is not set");

export const nearai = createOpenAICompatible({
  name: "nearai",                               // also the providerOptions key: providerOptions.nearai
  baseURL: "https://cloud-api.near.ai/v1",
  apiKey: apiKey ?? "",
  includeUsage: true,                           // stream_options.include_usage → token usage on streams
  supportsStructuredOutputs: true,              // models list "structured_outputs" in supported_features
  // fetch: capturingFetch,                     // §5: needed to verify response signatures
});

/** Fallback order. Every id must also be in MODEL_PRICING (pricing.ts). */
export const aiModels = ["z-ai/glm-5.3-flash", "Qwen/Qwen3.6-35B-A3B-FP8"];

type ModelRuntime = { thinking: boolean; maxOutputTokens: number };
const MODEL_RUNTIME: Record<string, ModelRuntime> = {
  "z-ai/glm-5.3-flash": { thinking: false, maxOutputTokens: 8192 },
  "Qwen/Qwen3.6-35B-A3B-FP8": { thinking: false, maxOutputTokens: 8192 },
};
export const modelRuntime = (id: string) => MODEL_RUNTIME[id] ?? { thinking: false, maxOutputTokens: 8192 };
export const chatModel = (id: string) => nearai.chatModel(id);
```

In `app/api/chat/route.ts` only the `providerOptions` block changes:

```ts
providerOptions: {
  nearai: {
    // Spread verbatim into the request body by @ai-sdk/openai-compatible (verified in dist/index.mjs).
    // docs.near.ai/cloud/reasoning-models: TEE models toggle thinking via chat_template_kwargs.
    chat_template_kwargs: { enable_thinking: runtime.thinking },
  },
},
```
- Reasoning comes back as `reasoning_content` (or `reasoning`); the provider maps both to AI SDK reasoning parts,
  so `sendReasoning: true` keeps working.
- There is no gateway-side `models` fallback. Retry yourself: catch the first error from `streamText` (or pre-check
  `is_ready` from `/v1/models`) and re-run with the next id from `aiModels`. `part.response?.modelId` in the
  `finish-step` handler still tells you which model served.
- Tool calling: `/v1/chat/completions` supports OpenAI `tools`/`tool_calls` ("tools" in `supported_features`).
  Trellis's zod tool schemas work unchanged. Verify each candidate with a 2-step tool call before switching. [VERIFY]
- Exact parity check for the explain-ptb route: same swap; it used `nvidia/nemotron-…:free`, which doesn't exist here.

## 2. Models and privacy tiers (live list, 2026-10-22)

docs.near.ai/cloud/models defines three tiers: **Confidential TEE** (NEAR AI's own GPUs in TEEs; attestation +
signatures), **3P Confidential TEE** ("Attested 3P", provider's own enclave), **Incognito** (OpenAI/Anthropic/Google/…;
only the gateway is in a TEE). `/v1/models` doesn't print the tier; `owned_by` lines up with it:
`"nearai"` ⇒ Confidential TEE, `"attested 3p"` ⇒ 3P TEE, vendor names ⇒ Incognito. Confirm on near.ai/models. [VERIFY]

Chat models worth trying for Trellis (USD per 1M tokens in/out, `supported_features`, `is_ready`):

| id | owned_by (tier) | price | features |
|---|---|---|---|
| `z-ai/glm-5.3-flash` | nearai (TEE) | 0.08 / 0.50 | tools, structured_outputs, reasoning, json_mode — used in NEAR AI's own SDK examples |
| `Qwen/Qwen3.6-35B-A3B-FP8` | nearai (TEE) | 0.17 / 1.10 | tools, json_mode, structured_outputs, logprobs, reasoning |
| `Qwen/Qwen3.8-27B` | nearai (TEE) | 0.04 / 1.35 | tools, structured_outputs, reasoning |
| `moonshotai/kimi-k2.6` | attested 3p | 0.81 / 3.85 | tools, structured_outputs (reasons by default) |
| `moonshotai/kimi-k3` | attested 3p | 3.30 / 16.50 | tools, json_mode, structured_outputs, reasoning |
| `deepseek/deepseek-v4.1-flash` | deepseek (tier unclear) | 0.30 / 1.20 | tools, json_mode, reasoning — closest to Trellis's current DeepSeek V4 Flash |
| `anthropic/*`, `openai/*`, `google/*`, `x-ai/*` | Incognito | various | not verifiable; don't use for the badge |

Always re-fetch before the demo; ids change (e.g. docs examples still mention `zai-org/GLM-5.1-FP8`, absent from the live list).

```ts
// Model refresh helper (public endpoint, no key)
export async function liveModels() {
  const r = await fetch("https://cloud-api.near.ai/v1/models", { next: { revalidate: 3600 } });
  const { data } = (await r.json()) as { data: Array<{ id: string; owned_by: string; is_ready?: boolean; supported_features?: string[]; pricing: { input: number; output: number } }> };
  return data.filter((m) => m.owned_by === "nearai" && m.supported_features?.includes("tools") && m.is_ready !== false);
}
```
`pricing.input/output` are USD per million tokens → feed Trellis's `MODEL_PRICING`.

## 3. What a signature proves (read before building the badge)

`GET /v1/signature/{chat_id}?signing_algo=…` returns `{ text, signature, signing_address, signing_algo, signature_kind }`:

| `signature_kind` | `text` | proves |
|---|---|---|
| `provider_tee` | `<MODEL_ID>:<sha256(req bytes)>:<sha256(resp bytes)>` | the model-serving TEE key signed exactly these bytes |
| `gateway` | `<sha256(req bytes)>:<sha256(resp bytes)>` | the TEE gateway signed the bytes it sent you |

- The gateway signs itself (`gateway`) by default on **streamed** completions, when it resolves an alias, and on the
  Responses API. Non-streamed + canonical model id + header `x-no-aliasing: true` → `provider_tee`.
- `ecdsa`: EIP-191 recover the signer from `text`, compare with `signing_address` (20-byte address).
  `ed25519`: verify UTF-8 `text` against `signing_address` (32-byte hex public key). Defaults differ between
  `/v1/signature` (ecdsa) and `/v1/attestation/report` (ed25519 for gateway) → always pass `signing_algo` explicitly.
- A 2xx body with `error_code`/`message` = unavailable; 404 = not recorded yet (retry briefly).
- The signer only means something if it matches a **preflight**-verified attestation: Intel TDX quote via DCAP
  (`dcap-qvl`), nonce + signer bound in report data, RTMR3 event-log replay, `app_compose` hash = MRCONFIGID, GPU evidence.
  That is heavy; use `@nearai/inference-sdk` (does all of it) or show a scoped badge ("signed by NEAR AI TEE key 0x…").
- Even fully verified, gateway + model evidence don't yet form one end-to-end chain (docs say so). Word the badge carefully.

## 4. Easiest path: `@nearai/inference-sdk` as the AI SDK fetch

```ts
// server-only, Node ≥ 24 (package engines). Vercel Node 24 runtime [VERIFY]; or do this in the worker.
import { InferenceClient } from "@nearai/inference-sdk/node";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const inference = new InferenceClient({
  apiKey: process.env.NEARAI_API_KEY!, baseUrl: "https://cloud-api.near.ai/v1/",
  signingAlgo: "ed25519", e2ee: true,                          // e2ee optional; verifies gateway + model attestation first
});
export const nearaiVerified = createOpenAICompatible({
  name: "nearai", baseURL: "https://cloud-api.near.ai/v1", apiKey: process.env.NEARAI_API_KEY!,
  fetch: inference.fetch as typeof fetch,                      // records exact request/response bytes
});
// after the stream is fully consumed:
const receipt = await inference.verifyResponse(completionId);  // throws if unverifiable
// receipt.signatureKind: "provider_tee" | "gateway"
```
Pattern is from the official example (`client-openai-sdk.ts`, which passes `inferenceClient.fetch` to the OpenAI SDK).
Using it under `@ai-sdk/openai-compatible` and with E2EE + tool calls is untested. [VERIFY]
Attestations are cached 60 min; response records have a 60-min TTL, so verify soon after the turn.

## 5. Manual path: capture bytes + verify (no Node 24 needed)

```ts
// web/src/lib/ai/capture.ts
import "server-only";
import { createHash } from "node:crypto";

type Captured = { model: string; reqHash: string; resHash: string; at: number };
const captured = new Map<string, Captured>(); // chatId -> hashes. Use Redis/KV in prod (serverless instances differ).
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export const capturingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  headers.set("x-no-aliasing", "true");             // keep the canonical model id in the signed text
  const res = await fetch(input, { ...init, headers });
  if (!url.endsWith("/chat/completions") || !res.body || typeof init?.body !== "string") return res;
  const reqBody = init.body;                         // AI SDK sends a JSON string: these are the exact bytes
  const model = JSON.parse(reqBody).model as string;
  const [toCaller, toHash] = res.body.tee();
  void (async () => {
    const bytes = new Uint8Array(await new Response(toHash).arrayBuffer()); // already decompressed by fetch: OK per docs
    const id = /"id"\s*:\s*"([^"]+)"/.exec(new TextDecoder().decode(bytes.subarray(0, 4096)))?.[1];
    if (id) captured.set(id, { model, reqHash: sha256(reqBody), resHash: sha256(bytes), at: Date.now() });
  })();
  return new Response(toCaller, { status: res.status, statusText: res.statusText, headers: res.headers });
};
export const getCapture = (id: string) => captured.get(id);
```

```ts
// web/src/lib/ai/verify.ts — adapted from docs.near.ai reference/response-signature-verification (Node helper)
import "server-only";
import nacl from "tweetnacl";                      // pnpm add tweetnacl
import { getCapture } from "./capture";

type Sig = { text: string; signature: string; signing_address: string; signing_algo: "ed25519" | "ecdsa"; signature_kind?: string };
const hex = (s: string) => Buffer.from(s.replace(/^0x/i, ""), "hex");

export async function verifyChat(chatId: string, trustedSigners: Set<string> /* hex ed25519 keys from verified attestation */) {
  const cap = getCapture(chatId);
  if (!cap) return { status: "no-capture" as const };
  const r = await fetch(`https://cloud-api.near.ai/v1/signature/${encodeURIComponent(chatId)}?signing_algo=ed25519`, {
    headers: { Authorization: `Bearer ${process.env.NEARAI_API_KEY}`, Accept: "application/json" },
  });
  if (r.status === 404) return { status: "pending" as const };
  const sig = (await r.json()) as Sig & { error_code?: string };
  if (sig.error_code || !sig.text) return { status: "unavailable" as const };

  const expected = sig.signature_kind === "provider_tee"
    ? `${cap.model}:${cap.reqHash}:${cap.resHash}`
    : sig.signature_kind === "gateway" ? `${cap.reqHash}:${cap.resHash}` : null;
  if (!expected || sig.text !== expected) return { status: "mismatch" as const };
  const ok = sig.signing_algo === "ed25519" &&
    nacl.sign.detached.verify(Buffer.from(sig.text, "utf8"), hex(sig.signature), hex(sig.signing_address));
  if (!ok) return { status: "bad-signature" as const };
  const attested = trustedSigners.has(sig.signing_address.toLowerCase().replace(/^0x/, ""));
  return { status: attested ? "verified" as const : "signed-unattested" as const, kind: sig.signature_kind, signer: sig.signing_address, text: sig.text };
}
```
`trustedSigners`: fetch `/v1/attestation/report?signing_algo=ed25519&nonce=<64 hex>` (+ `model=…&provider=near` with
`x-no-aliasing: true`) at boot / hourly, check `request_nonce` echo, and collect `gateway_attestation.signing_address`
and each `model_attestations[].signing_address`. Without DCAP quote verification this is "trust on first fetch";
say so in the UI tooltip. Field names per docs; exact JSON nesting of `gateway_attestation` [VERIFY] with a key.

## 6. Wiring the badge into Trellis

1. `streamText(... { model: chatModel(id) })` with `fetch: capturingFetch` on the provider.
2. In `toUIMessageStreamResponse({ messageMetadata })`, on `part.type === "finish-step"` push
   `part.response?.id` (the chat-completion id; one per tool-loop step) into metadata `aiProof: string[]`.
3. Client calls `GET /api/verify-ai?id=…` after the message finishes; render "Verified AI decision" only for
   `verified`; "Signed" for `signed-unattested`; nothing otherwise.
4. For **agent actions**, store `{ chatId, signature JSON, reqHash, resHash, model }` in the reasoning log and pass
   `reason_hash = sha256(canonical JSON of that record)` to the vault's `agent_*` call, so the on-chain receipt
   links to the signed AI output (vault-spec §9).
5. Streaming turns usually get `gateway` signatures; for a `provider_tee` badge on decisions, make the worker's
   decision call non-streamed with the canonical model id.

## 7. Other endpoints that may matter
- `/v1/responses` (stateless, `store: false`), `/v1/embeddings`, `/v1/rerank`, `/v1/privacy/redact` (PII) — all OpenAI-shaped.
- Billing: `inference-id` response header ↔ costs API. `X-Request-Id` header for support.
- E2EE chat (encrypt prompt to the model's attested key) via the SDK: useful talking point for the AI Security track.

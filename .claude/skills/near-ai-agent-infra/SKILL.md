---
name: near-ai-agent-infra
description: Off-chain agent infrastructure for Trellis. (1) NEAR AI Cloud as the LLM backend: OpenAI-compatible API at cloud-api.near.ai/v1 used from the Vercel AI SDK, model tiers (Confidential TEE vs 3P TEE vs Incognito), tool calling, reasoning toggles, response signatures (/v1/signature/{chat_id}) + attestation reports and how to verify them for a "verified AI decision" badge. (2) The Node agent worker: agent account `agent.trellis.near`, per-vault function-call keys (receiver, method_names, allowance) via near-api-js or near CLI, NEP-611 gas keys, signing from Node, nonce handling, polling loop (health-factor checks, idempotency, backoff), hosting on Railway/Fly, key storage, heartbeat. (3) OutLayer (TEE custody wallets / verifiable WASI compute) as a stretch option. Triggers: NEAR AI Cloud, cloud-api.near.ai, verifiable inference, attestation, OutLayer, agent worker, function-call key, gas key, agent account.
---

# NEAR AI + agent worker infra (Trellis)

Researched 2026-10-22. Product context: `docs/research.md`, `docs/vault-spec.md`.
Out of scope here (other skills): wallet/RPC basics and NEP-297 parsing (`near-frontend`), vault contract
(`near-rust-contracts`), Burrow HF math and call shapes (`rhea-burrow-lending`), Ref swaps (`ref-dex-swaps`),
Intents (`near-intents`), sandbox tests (`near-contract-testing`).

## Architecture in one picture

```
Next.js (Vercel)                         Worker (Railway/Fly, always-on Node)
 /api/chat ── AI SDK streamText ──▶ NEAR AI Cloud (cloud-api.near.ai/v1, TEE models)
   tools build user txs (wallet signs)     ▲ decisions needing judgment (optional)
 /api/verify-ai ─▶ /v1/signature/{id}       │
                                          loop every 10–30 s per vault:
 vault events ◀── NearBlocks / RPC          read vault get_status + Burrow positions + oracle
                                            → deterministic rules (HF floor, stop-loss, DCA)
                                            → agent.trellis.near signs agent_* call with that
                                              vault's function-call key (deposit 0)
                                            → heartbeat → Cloudflare cron / uptime alert
```
The vault contract enforces the policy; the worker and the LLM are untrusted by design. Keep the money
path deterministic (rules in the worker), and use the LLM for planning/explaining, with its signed output
hashed into the vault's `reason_hash`.

## Key facts (verified)

| Item | Value |
|---|---|
| NEAR AI base URL | `https://cloud-api.near.ai/v1` (OpenAI-compatible; chat completions, tools, structured outputs, streaming, `/v1/responses` stateless) |
| Auth | `Authorization: Bearer <NEARAI_API_KEY>` from cloud.near.ai dashboard (credits prepaid) |
| Model list | `GET /v1/models` is public; has `owned_by`, `supported_features`, `pricing`, `is_ready` |
| AI SDK for Trellis (`ai@^6`) | `@ai-sdk/openai-compatible@ai-v6` = **2.0.87** (latest 3.x targets `ai@7`) |
| Signatures | `GET /v1/signature/{chat_id}?signing_algo=ecdsa|ed25519` (API key); kinds `provider_tee` / `gateway` |
| Attestation | `GET /v1/attestation/report?model=…&provider=near&signing_algo=…&nonce=…` (API key, non-billable) |
| JS verifier SDK | `@nearai/inference-sdk` **0.1.0** (Node ≥ 24): `InferenceClient.fetch` + `verifyResponse(id)` |
| Mainnet protocol | 86 (FastNEAR `status`, nearcore 2.13.4) → gas keys (NEP-611, ≥ 85) are live |
| near-api-js | 7.3.1: FC keys yes; gas keys only error types (no TransactionV1 signing) → `@fastnear/api` 2.5.0 `sendTx` |
| OutLayer | Live on mainnet (`outlayer.near`, `api.outlayer.ai`) and testnet (`outlayer.testnet`, `testnet-api.outlayer.ai`) |

## Common mistakes

1. Installing `@ai-sdk/openai-compatible@latest` (3.x, provider spec v4) into Trellis's `ai@6` app. Pin `@ai-sdk/openai-compatible@ai-v6`.
2. Assuming every NEAR AI model is private/verifiable. Anthropic/OpenAI/Google models are **Incognito** (gateway in TEE, model not). Only Confidential TEE models give `provider_tee` signatures.
3. Verifying a signature against re-serialized JSON. The signed text hashes the **exact** request and response bytes; capture them in a custom `fetch`.
4. Treating a missing/404 signature as verified. It's "unverified"; retry briefly, then show the badge as unavailable.
5. Putting the agent's **full-access** key on the worker. The worker holds only per-vault function-call keys.
6. Function-call keys with an allowance that silently runs out (`NotEnoughAllowance`). Allowance can't be topped up; monitor and rotate, or use gas keys.
7. Sending from two processes with the same key → nonce collisions. One owner process per key.
8. Using OpenRouter-only options (`providerOptions.openrouter.reasoning`, `models` fallback). On NEAR AI use `providerOptions.nearai.chat_template_kwargs.enable_thinking` and do fallback yourself.
9. Registering any agent key on `intents.near` (`add_public_key`): unrestricted control of the vault's Intents balance. Never.

## Reference index

- [near-ai-cloud.md](near-ai-cloud.md): swap OpenRouter → NEAR AI in `web/src/lib/ai/openrouter.ts`, models + tiers (live list), tool calling, reasoning, signatures + attestation, JS verification for the badge.
- [agent-worker.md](agent-worker.md): agent account setup, per-vault FC keys (near-api-js + CLI), gas keys, signing + nonces, polling loop design, Railway/Fly, key storage, heartbeat.
- [outlayer.md](outlayer.md): what OutLayer is, HTTPS API, custody wallet + policy, secrets/CKD, attestation, pricing, testnet, whether it can hold Trellis's agent key (stretch).

## Sources (fetched 2026-10-22)

- docs.near.ai: `llms.txt`, `/cloud/models`, `/cloud/guides/openai-compatibility`, `/cloud/reasoning-models`,
  `/cloud/verification/*` (response-signatures, model-attestations, reference/response-signature-verification),
  `/cloud/inference-sdk/javascript`, `/api-reference/attestation/*`. Live `GET https://cloud-api.near.ai/v1/models`.
- github.com/nearai/inference-sdk `examples/example-js/gateway/client-openai-sdk.ts`; npm `@nearai/inference-sdk@0.1.0`.
- npm `@ai-sdk/openai-compatible@2.0.87` (`dist/index.mjs`: providerOptions passthrough, `reasoning_content` parsing), dist-tags.
- `../sprout/web/src/lib/ai/openrouter.ts`, `../sprout/web/src/app/api/chat/route.ts` (read-only).
- near-api-js 7.3.1 source (Account, NonceManager, FailoverRpcProvider), `@fastnear/api@2.5.0` d.ts,
  js.fastnear.com/gas-keys.html, docs.near.org/protocol/transactions/meta-tx, docs.near.org/tools/cli (gas keys),
  near-cli-rs `docs/GUIDE.en.md` (grant-function-call-access).
- app.outlayer.ai/llms.txt + llms-full.txt, `api.outlayer.ai/openapi.json`, `api.outlayer.ai/public/pricing`, `testnet-api.outlayer.ai/health`.

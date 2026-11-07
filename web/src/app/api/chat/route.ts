import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { replayChatResponse, replayEnabled } from "@/lib/server/demo-replay";
import {
  chatModel,
  modelRuntime,
  nearaiConfigured,
  DEFAULT_MODEL,
} from "@/lib/ai/nearai";
import { isKnownModel } from "@/lib/ai/pricing";
import { systemPrompt } from "@/lib/ai/system-prompt";
import { allTools } from "@/lib/ai/tools";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/chat-limits";
import { isValidAccountId, NEAR_NETWORK } from "@/lib/near/config";

export const maxDuration = 60;

// The client (useChat) replays the whole conversation each request, so it grows
// unbounded over a session. Only forward the most recent turns to the model.
const MAX_MESSAGES = 10;

export async function POST(req: Request) {
  // replay demo: a scripted answer, no LLM (lib/server/demo-replay.ts)
  if (replayEnabled()) {
    const { messages = [] }: { messages?: UIMessage[] } = await req.json();
    return replayChatResponse(messages);
  }
  if (!nearaiConfigured()) {
    return new Response(
      JSON.stringify({
        error:
          "NEARAI_API_KEY is not set. Create a key at https://cloud.near.ai, add it to web/.env.local and restart the dev server.",
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const {
    messages: incoming = [],
    model: requestedModel,
    accountId: rawAccountId = null,
  }: {
    messages?: UIMessage[];
    model?: string;
    accountId?: string | null;
  } = await req.json();

  // The client picks a model in the input; only ids in the pricing table are
  // accepted. Anything else falls back to the server default (NEARAI_MODEL).
  const modelId =
    requestedModel && isKnownModel(requestedModel)
      ? requestedModel
      : DEFAULT_MODEL;

  // The connected account is a display hint for the model only. It is NOT an
  // authorization: every read tool runs in the browser against public data,
  // and every write is signed by the user's wallet (or checked by the vault).
  const accountId =
    typeof rawAccountId === "string" && isValidAccountId(rawAccountId)
      ? rawAccountId
      : null;

  // Keep only the most recent messages, starting at a user turn so the model
  // context begins cleanly (never on a dangling assistant/tool message).
  let messages = incoming.slice(-MAX_MESSAGES);
  const firstUser = messages.findIndex((m) => m.role === "user");
  if (firstUser > 0) messages = messages.slice(firstUser);

  // Clamp each user message's text so a single message can't spam the model.
  messages = messages.map((m) =>
    m.role !== "user"
      ? m
      : {
          ...m,
          parts: m.parts.map((p) =>
            p.type === "text"
              ? { ...p, text: p.text.slice(0, MAX_USER_MESSAGE_CHARS) }
              : p,
          ),
        },
  );

  const startedAt = Date.now();

  // Per-request context goes on the LATEST user message, not the system
  // prompt, so the system prompt stays a stable cacheable prefix.
  const modelMessages = await convertToModelMessages(messages);
  const context =
    `<context>\n` +
    (accountId
      ? `Connected NEAR account: ${accountId}`
      : `No wallet connected.`) +
    `\nNetwork: NEAR ${NEAR_NETWORK}` +
    `\nCurrent time: ${new Date().toISOString()}\n</context>`;
  for (let i = modelMessages.length - 1; i >= 0; i--) {
    const m = modelMessages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      m.content = `${m.content}\n\n${context}`;
    } else {
      m.content = [...m.content, { type: "text", text: `\n\n${context}` }];
    }
    break;
  }

  const runtime = modelRuntime(modelId);

  const result = streamText({
    model: chatModel(modelId),
    system: systemPrompt,
    messages: modelMessages,
    tools: allTools,
    stopWhen: ({ steps }) => steps.length >= 10,
    maxOutputTokens: runtime.maxOutputTokens,
    // Cancel the upstream LLM call when the client disconnects.
    abortSignal: req.signal,
    onAbort: () => {
      console.log("[api/chat] aborted by client disconnect");
    },
    onError: (e) => {
      console.error("[api/chat] streamText error", e);
    },
    onFinish: ({ finishReason, usage }) => {
      console.log("[api/chat] finish", { modelId, finishReason, usage });
    },
    providerOptions: {
      nearai: {
        // Spread into the request body by @ai-sdk/openai-compatible. NEAR AI
        // TEE models toggle thinking via chat_template_kwargs (near-ai-cloud.md §1).
        chat_template_kwargs: { enable_thinking: runtime.thinking },
      },
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
    // Surface provider errors (bad key, model down) to the chat instead of a
    // generic "An error occurred".
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { statusCode?: number } | null)?.statusCode;
      if (status === 401 || /invalid (or expired )?api key|unauthori[sz]ed/i.test(msg)) {
        return "NEAR AI Cloud rejected the API key. Check NEARAI_API_KEY in web/.env.local.";
      }
      if (status === 404 || /model .*not found/i.test(msg)) {
        return `NEAR AI Cloud doesn't serve model "${modelId}" right now. Pick another model or set NEARAI_MODEL.`;
      }
      return `The model call failed: ${msg.slice(0, 300)}`;
    },
    // Usage + duration on the final chunk for the cost/duration footer.
    messageMetadata: ({ part }) => {
      if (part.type === "finish") {
        return {
          usage: {
            inputTokens: part.totalUsage?.inputTokens,
            outputTokens: part.totalUsage?.outputTokens,
            cachedInputTokens: part.totalUsage?.cachedInputTokens,
            totalTokens: part.totalUsage?.totalTokens,
            model: modelId,
          },
          durationMs: Date.now() - startedAt,
        };
      }
    },
  });
}

import { generateText } from "ai";
import { chatModel, DEFAULT_MODEL, nearaiConfigured } from "@/lib/ai/nearai";
import { describeAction } from "@/lib/near/decode";
import type { NearTx } from "@/lib/near/tx";
import { json, errorMessage } from "../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Plain-English explanation of a NEAR transaction list (frontend-spec §4.4).
 * Only runs when the user clicks
 * "Summarize" / "Explain this step". The deterministic decoder output is
 * passed in as ground truth so the model explains rather than guesses.
 */
export async function POST(req: Request) {
  if (!nearaiConfigured()) return json({ error: "NEARAI_API_KEY is not set." }, 500);
  const body = (await req.json().catch(() => null)) as { txs?: NearTx[]; focusCommand?: number } | null;
  const txs = body?.txs;
  if (!Array.isArray(txs) || txs.length === 0 || JSON.stringify(txs).length > 40_000) {
    return json({ error: "Send 1+ transactions (max 40 KB)." }, 400);
  }
  const lines: string[] = [];
  let i = 0;
  for (const [ti, tx] of txs.entries()) {
    for (const a of tx.actions ?? []) {
      const d = describeAction(String(tx.receiverId), a);
      lines.push(
        `#${i} (tx ${ti + 1} → ${tx.receiverId}) decoded: "${d.text}"${d.known ? "" : " [UNKNOWN METHOD]"} raw: ${JSON.stringify(a.params).slice(0, 1200)}`,
      );
      i++;
    }
  }
  const focus = typeof body?.focusCommand === "number" ? body.focusCommand : null;
  const prompt =
    focus === null
      ? `Explain these NEAR transactions for a non-expert in plain English. They run in order and are NOT atomic across transactions. Reply ONLY with JSON: {"summary": "<2-3 sentences>", "commands": [{"index": <n>, "plain": "<one short sentence>"}]} covering every #index.\n\n${lines.join("\n")}`
      : `Explain action #${focus} of these NEAR transactions in 2-4 plain sentences: what it does, what the user gives and gets, and any risk. Reply ONLY with JSON: {"explanation": "..."}\n\n${lines.join("\n")}`;
  try {
    const { text } = await generateText({
      model: chatModel(DEFAULT_MODEL),
      system:
        "You explain NEAR blockchain transactions plainly. Trust the decoded line over your assumptions. Never invent amounts. No em dashes.",
      prompt,
      maxOutputTokens: 1500,
      providerOptions: { nearai: { chat_template_kwargs: { enable_thinking: false } } },
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "The model didn't return an explanation." }, 502);
    return json(JSON.parse(m[0]));
  } catch (e) {
    return json({ error: `Explain failed: ${errorMessage(e)}` }, 502);
  }
}

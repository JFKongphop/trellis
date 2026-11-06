"use client";

import { IntentsDepositCard, type FundTarget } from "@/components/intents/intents-deposit-card";
import { useNearAccount } from "@/lib/near/use-near-account";
import { motion } from "motion/react";
import type { UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ThinkingTrail } from "@/components/parts/thinking-trail";
import { ToolCallRow } from "@/components/parts/tool-call-row";
import {
  ExplainerTrail,
  type ExplainerItem,
} from "@/components/parts/explainer-trail";
import { WalletCard, type WalletBalance } from "@/components/parts/wallet-card";
import { LendingPositionCard } from "@/components/parts/lending-position-card";
import { LendingMarketsCard } from "@/components/parts/lending-markets-card";
import {
  TokenListCard,
  type TokenListRow,
} from "@/components/parts/token-list-card";
import {
  MessageFooter,
  type MessageMeta,
} from "@/components/parts/message-footer";
import type { LendingMarket, LendingPosition } from "@/lib/near/client";
import { NearPlanCard } from "@/components/parts/near-plan-card";
import { PolicyCard } from "@/components/parts/policy-card";
import { VaultSummaryCard, type VaultSummary } from "@/components/parts/vault-summary-card";
import { planCache } from "@/lib/ai/plan-cache";

type IconLookup = (tokenId: string) => string | undefined;

type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

/** Common shape of a client-run tool part (AI SDK v6 typed tool parts). */
type ToolPart<I, O> = {
  toolCallId: string;
  state: ToolState;
  input?: I;
  output?: O & { error?: string };
  errorText?: string;
};

type Props = {
  message: UIMessage;
  isStreaming: boolean;
  /** Resolves token icons (display-only; never sent to the model). */
  iconLookup: IconLookup;
  /** True only for the last assistant message — controls regenerate visibility. */
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  /** Connected wallet (plan cards: sign / approve). */
  accountId: string | null;
  /** Send a follow-up to the agent (retry / rebuild buttons). */
  onAskAgent: (text: string) => void;
};

/** Short header for a failed plan build (the model retries on its own). */
function planErrorLabel(raw: string | undefined): string {
  const text = String(raw ?? "");
  if (/Type validation failed|Invalid input for tool|Invalid plan/i.test(text)) return "bad plan format, retrying";
  const clean = text.split(/\s*FIX:/i)[0].replace(/^(Plan build failed|Vault plan failed):\s*/i, "").trim();
  return clean ? `couldn't build it. ${clean.slice(0, 120)}` : "couldn't build that one";
}

/**
 * Some models leak their chat-template role/stop delimiters into the visible
 * text — a stray `</assistant>`, `<|im_end|>`, `</s>`, etc. Strip those
 * template tokens so they never render as content.
 */
const MODEL_TOKEN_RE =
  /<\/?\s*(?:assistant|user|system|tool)\s*>|<\|[^|>]*\|>|<\/?s>/gi;
function stripModelTokens(text: string): string {
  return text.replace(MODEL_TOKEN_RE, "").trim();
}

/**
 * The flash model leaks the classic AI tell (em/en dashes) no matter what the
 * system prompt says, so we strip them deterministically at render. An em dash
 * in casual prose reads fine as a comma; a digit-bounded en dash is a numeric
 * range, so keep that a hyphen.
 */
function deDash(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/\s*[—–―]\s*/g, ", ");
}

export function AgentMessage({
  message,
  isStreaming,
  iconLookup,
  canRegenerate = false,
  onRegenerate,
  accountId,
  onAskAgent,
}: Props) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ type: "spring", visualDuration: 0.3, bounce: 0.2 }}
        className="flex justify-end"
      >
        <div className="max-w-[80%] break-words [overflow-wrap:anywhere] bg-surface-charcoal px-3.5 py-2 text-body-sm text-canvas-white rounded-card">
          {message.parts
            .filter((p) => p.type === "text")
            .map((p, i) => (
              <span key={i}>{(p as { text: string }).text}</span>
            ))}
        </div>
      </motion.div>
    );
  }

  return (
    <div className="space-y-2">
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;

        if (part.type === "reasoning") {
          // AI SDK reasoning part shape: { type: 'reasoning', text: string, state? }
          const text = stripModelTokens((part as { text?: string }).text ?? "");
          // Streaming heuristic: the message is the last one and overall stream is active
          return (
            <ThinkingTrail key={key} text={text} streaming={isStreaming} />
          );
        }

        if (part.type === "text") {
          const text = deDash(stripModelTokens((part as { text: string }).text));
          if (!text) return null;
          return (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="surface-card min-w-0 w-fit max-w-[640px] break-words [overflow-wrap:anywhere] px-3.5 py-2.5 text-body-sm text-midnight-ink rounded-card"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // Inline-only: no h1-h6, no images, no raw html. Lists, bold,
                  // italic, code, links stay. Keep paragraphs as plain spans
                  // so consecutive text parts don't gain extra block margin.
                  p: ({ children }) => <p className="m-0">{children}</p>,
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-midnight-ink underline underline-offset-2 decoration-midnight-ink decoration-2"
                    >
                      {children}
                    </a>
                  ),
                  code: ({ children }) => (
                    <code className="rounded-md bg-whisper-gray px-1.5 py-0.5 font-mono text-[0.85em] text-midnight-ink">
                      {children}
                    </code>
                  ),
                  ul: ({ children }) => (
                    <ul className="my-2 list-disc pl-5">{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="my-2 list-decimal pl-5">{children}</ol>
                  ),
                  li: ({ children }) => <li className="my-0.5">{children}</li>,
                  // Markdown tables — system prompt discourages them, but
                  // style cleanly as a fallback so they don't look broken.
                  table: ({ children }) => (
                    <div className="my-3 overflow-hidden bg-whisper-gray ring-1 ring-hairline rounded-card">
                      <table className="w-full border-collapse text-body-sm">
                        {children}
                      </table>
                    </div>
                  ),
                  thead: ({ children }) => (
                    <thead className="bg-whisper-gray text-caption font-medium uppercase tracking-wide text-muted-ash">
                      {children}
                    </thead>
                  ),
                  tbody: ({ children }) => (
                    <tbody className="bg-canvas-white">{children}</tbody>
                  ),
                  tr: ({ children }) => (
                    <tr className="border-b border-hairline last:border-b-0">
                      {children}
                    </tr>
                  ),
                  th: ({ children }) => (
                    <th className="px-3 py-2 text-left font-medium">
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td className="px-3 py-2">{children}</td>
                  ),
                  strong: ({ children }) => (
                    <strong className="font-semibold font-alt text-midnight-ink">
                      {children}
                    </strong>
                  ),
                }}
              >
                {text}
              </ReactMarkdown>
            </motion.div>
          );
        }

        // Shared pending / error handling for client-run read tools.
        const pending = (
          p: ToolPart<unknown, unknown>,
          working: string,
          failed: string,
        ) => {
          if (p.state === "output-error") {
            return (
              <ToolCallRow
                key={key}
                label={`${failed}: ${p.errorText ?? "unknown error"}`}
                status="output-error"
              />
            );
          }
          if (p.state !== "output-available") {
            return <ToolCallRow key={key} label={working} status={p.state} />;
          }
          if (p.output?.error) {
            return (
              <ToolCallRow key={key} label={p.output.error} status="output-error" />
            );
          }
          return null;
        };

        if (part.type === "tool-getBalances") {
          const p = part as unknown as ToolPart<
            { accountId?: string },
            { accountId?: string; balances?: WalletBalance[] }
          >;
          return (
            pending(p, "Reading balances…", "Balance read failed") ?? (
              <WalletCard
                key={key}
                accountId={p.output?.accountId}
                balances={p.output?.balances ?? []}
                iconLookup={iconLookup}
              />
            )
          );
        }

        if (part.type === "tool-getLendingPosition") {
          const p = part as unknown as ToolPart<
            { accountId?: string },
            { position?: LendingPosition }
          >;
          const early = pending(
            p,
            "Reading Rhea Lending position…",
            "Position read failed",
          );
          if (early) return early;
          if (!p.output?.position) return null;
          return (
            <LendingPositionCard
              key={key}
              position={p.output.position}
              iconLookup={iconLookup}
            />
          );
        }

        if (part.type === "tool-getLendingMarkets") {
          const p = part as unknown as ToolPart<
            { token?: string },
            { markets?: LendingMarket[] }
          >;
          const early = pending(
            p,
            p.input?.token
              ? `Reading Rhea ${p.input.token} market…`
              : "Reading Rhea Lending markets…",
            "Markets read failed",
          );
          if (early) return early;
          return (
            <LendingMarketsCard
              key={key}
              markets={p.output?.markets ?? []}
              iconLookup={iconLookup}
            />
          );
        }

        if (part.type === "tool-getTokenPrice") {
          const p = part as unknown as ToolPart<
            { tokens?: string[] },
            { prices?: TokenListRow[] }
          >;
          const early = pending(p, "Reading prices…", "Price read failed");
          if (early) return early;
          return (
            <TokenListCard
              key={key}
              title="Prices · Ref indexer (display only)"
              rows={p.output?.prices ?? []}
              iconLookup={iconLookup}
            />
          );
        }

        if (part.type === "tool-searchToken") {
          const p = part as unknown as ToolPart<
            { query?: string },
            { results?: TokenListRow[] }
          >;
          const early = pending(
            p,
            p.input?.query ? `Looking up "${p.input.query}"…` : "Looking up token…",
            "Token search failed",
          );
          if (early) return early;
          return (
            <TokenListCard
              key={key}
              title={`Matches for "${p.input?.query ?? ""}"`}
              rows={p.output?.results ?? []}
              iconLookup={iconLookup}
            />
          );
        }

        if (part.type === "tool-executePlan" || part.type === "tool-proposeVaultActions") {
          const p = part as unknown as ToolPart<{ steps?: unknown[] }, { summary?: string }>;
          const vault = part.type === "tool-proposeVaultActions";
          if (p.state === "output-error" || p.output?.error) {
            return (
              <ToolCallRow key={key} label={planErrorLabel(p.output?.error ?? p.errorText)} status="output-error" />
            );
          }
          if (p.state !== "output-available") {
            const n = p.input?.steps?.length;
            return (
              <ToolCallRow
                key={key}
                label={`${vault ? "Checking vault plan" : "Building plan"}${n ? ` · ${n} step${n === 1 ? "" : "s"}` : ""}…`}
                status={p.state}
              />
            );
          }
          const cached = planCache.get(p.toolCallId);
          if (!cached) {
            return <ToolCallRow key={key} label="Plan expired. Ask again to rebuild it." status="output-error" />;
          }
          return (
            <NearPlanCard
              key={key}
              plan={cached.plan}
              approval={cached.approval}
              accountId={accountId}
              onAskAgent={onAskAgent}
            />
          );
        }

        if (part.type === "tool-proposePolicy") {
          const p = part as unknown as ToolPart<unknown, { summary?: string; preset?: string; link?: string; errors?: string[] }>;
          const early = pending(p, "Drafting vault rules…", "Couldn't draft rules");
          if (early) return early;
          return (
            <PolicyCard
              key={key}
              summary={p.output?.summary ?? ""}
              preset={p.output?.preset ?? "custom"}
              link={p.output?.link ?? "/vault/setup"}
              errors={p.output?.errors ?? []}
            />
          );
        }

        if (part.type === "tool-fundFromChain") {
          const p = part as unknown as ToolPart<
            unknown,
            { error?: string; targets?: FundTarget[]; prefill?: Parameters<typeof IntentsDepositCard>[0]["prefill"] }
          >;
          const early = pending(p, "Preparing a cross-chain deposit…", "Couldn't open the deposit card");
          if (early) return early;
          if (p.output?.error || !p.output?.targets?.length) {
            return <ToolCallRow key={key} label={p.output?.error ?? "No destination account"} status="output-error" />;
          }
          return <ChatFundCard key={key} targets={p.output.targets} prefill={p.output.prefill} />;
        }

        if (part.type === "tool-getVault") {
          const p = part as unknown as ToolPart<
            unknown,
            {
              exists?: boolean;
              vaultId?: string;
              paused?: boolean;
              agent?: string;
              position?: { healthFactor?: number | null; netValueUsd?: number };
              balances?: { valueUsd?: number }[];
              recentActions?: { what: string; status: string; when: string }[];
            }
          >;
          const early = pending(p, "Reading your vault…", "Vault read failed");
          if (early) return early;
          const o = p.output ?? {};
          const v: VaultSummary = {
            exists: !!o.exists,
            vaultId: o.vaultId,
            paused: o.paused,
            agent: o.agent ?? null,
            healthFactor: o.position?.healthFactor ?? null,
            netValueUsd: o.position?.netValueUsd,
            walletUsd: (o.balances ?? []).reduce((s, b) => s + (b.valueUsd ?? 0), 0),
            receipts: o.recentActions,
          };
          return <VaultSummaryCard key={key} v={v} />;
        }

        if (part.type === "tool-explainConcept") {
          // Collapse a consecutive run of explainer lookups into one subtle
          // reference pill (the agent quotes each explanation inline, so this
          // is just a "what I referenced" acknowledgement). Only the run
          // leader renders; later members in the run return null.
          const prev = message.parts[i - 1];
          if (prev?.type === "tool-explainConcept") return null;

          const run: ExplainerItem[] = [];
          for (
            let j = i;
            j < message.parts.length &&
            message.parts[j].type === "tool-explainConcept";
            j++
          ) {
            const ep = message.parts[j] as unknown as {
              toolCallId: string;
              state: ExplainerItem["state"];
              input?: { key?: string };
              output?: { key?: string };
            };
            run.push({
              id: ep.toolCallId,
              conceptKey: ep.output?.key ?? ep.input?.key ?? "concept",
              state: ep.state,
            });
          }
          return <ExplainerTrail key={key} items={run} />;
        }

        return null;
      })}

      {!isStreaming && (
        <MessageFooter
          meta={(message as { metadata?: MessageMeta }).metadata}
          canRegenerate={canRegenerate}
          onRegenerate={onRegenerate}
        />
      )}
    </div>
  );
}

/** Deposit card inside the chat (signer = the connected wallet, for token registration). */
function ChatFundCard({ targets, prefill }: { targets: FundTarget[]; prefill?: Parameters<typeof IntentsDepositCard>[0]["prefill"] }) {
  const { accountId } = useNearAccount();
  return (
    <div className="w-full max-w-[640px]">
      <IntentsDepositCard targets={targets} signer={accountId ?? undefined} prefill={prefill} />
    </div>
  );
}

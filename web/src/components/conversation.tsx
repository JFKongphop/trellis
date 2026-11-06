"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown } from "lucide-react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useStickToBottom } from "use-stick-to-bottom";
import { ChatInput } from "@/components/chat-input";
import { ExamplePrompts } from "@/components/example-prompts";
import { AgentMessage } from "@/components/agent-message";
import { ErrorBanner } from "@/components/parts/error-banner";
import { CinematicShell } from "@/components/parts/cinematic-shell";
import { LiquidBlob } from "@/components/parts/liquid-blob";
import { HeroStatStrip } from "@/components/parts/hero-stat-strip";
import { LiveMainnetBadge } from "@/components/parts/live-mainnet-badge";
import { useRegisterChatReset } from "@/components/chat-reset";
import { SPRING_BOUNCY } from "@/lib/motion";
import { subscribeAskTrellis, takePendingAsk } from "@/lib/ask-trellis";
import { signedFetch } from "@/lib/api-client";
import { defaultModelId } from "@/lib/ai/pricing";
import { pruneForModel } from "@/lib/ai/prune-output";
import { getGlossary } from "@/lib/ai/vault-glossary";
import { floorToDecimals } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isValidAccountId, TOKENS, WRAP_NEAR } from "@/lib/near/config";
import { useNearAccount } from "@/lib/near/use-near-account";
import { planCache } from "@/lib/ai/plan-cache";
import type { VaultPlan, WalletPlan } from "@/lib/ai/plan-types";
import type { VaultApproval } from "@/components/parts/near-plan-card";
import { receiptAgo, receiptText } from "@/lib/near/receipt-text";
import { hfFromBps } from "@/lib/near/vault";
import {
  PRESETS,
  VAULT_TOKENS,
  encodeRules,
  rulesSummary,
  validateRules,
  type RulesForm,
} from "@/lib/vault-presets";
import {
  fetchBalances,
  fetchMarkets,
  fetchVaultOwner,
  fetchVaultState,
  postJson,
  fetchPosition,
  fetchPrices,
  fetchTokenSearch,
  iconFor,
  rememberIcons,
  type LendingMarket,
} from "@/lib/near/client";

type AddResultFn = (args: {
  tool: string;
  toolCallId: string;
  output: unknown;
}) => Promise<void> | void;

type ToolCall = { toolCallId: string; toolName: string; input: unknown };

/** Round for the model's context (cards render the full numbers). */
const r = (n: number | undefined, dp = 4) =>
  n === undefined || !Number.isFinite(n) ? undefined : Number(n.toFixed(dp));

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Symbols that map to a well-known token id without a search. */
const KNOWN_SYMBOLS: Record<string, string> = {
  near: WRAP_NEAR,
  wnear: WRAP_NEAR,
  usdc: TOKENS.USDC,
  usdt: TOKENS.USDT,
  "usdc.e": TOKENS["USDC.e"],
  "usdt.e": TOKENS["USDT.e"],
};

const looksLikeAccountId = (s: string) =>
  isValidAccountId(s) && (s.includes(".") || /^[0-9a-f]{64}$/.test(s));

// Lending markets change slowly; cache for 30s across tool calls in a session.
let marketsCache: { at: number; data: LendingMarket[] } | null = null;
async function cachedMarkets(): Promise<LendingMarket[]> {
  if (marketsCache && Date.now() - marketsCache.at < 30_000) return marketsCache.data;
  const data = await fetchMarkets();
  marketsCache = { at: Date.now(), data };
  return data;
}

export function Conversation({
  embedded = false,
  surface,
}: { embedded?: boolean; surface?: "rail" | "sheet" } = {}) {
  const { accountId } = useNearAccount();

  // Stick-to-bottom for the active conversation (inner scroller so the
  // scroll-to-bottom button can sit in a non-scrolling wrapper).
  const { scrollRef, contentRef, escapedFromLock, isAtBottom, scrollToBottom } =
    useStickToBottom({ resize: "smooth", initial: "smooth" });

  // Refs so the memoized transport / onToolCall closure read live values.
  const accountRef = useRef(accountId);
  useEffect(() => {
    accountRef.current = accountId;
  }, [accountId]);

  const [signError, setSignError] = useState<string | null>(null);

  // User-selected chat model (picked in the input).
  const [selectedModel, setSelectedModel] = useState(defaultModelId());
  const modelRef = useRef(selectedModel);
  useEffect(() => {
    modelRef.current = selectedModel;
  }, [selectedModel]);

  // The connected account travels in the request body (not the system prompt)
  // so the server can inject it per turn without breaking prompt caching.
  // The refs are read inside prepareSendMessagesRequest, which runs at request
  // time (never during render); the compiler can't see that, hence the disable.
  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      new DefaultChatTransport({
        api: "/api/chat",
        fetch: signedFetch,
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            ...body,
            messages,
            model: modelRef.current,
            accountId: accountRef.current ?? null,
          },
        }),
      }),
    [],
  );

  // useChat's onToolCall captures the first render; keep addToolResult fresh.
  const addToolResultRef = useRef<AddResultFn | null>(null);

  const {
    messages,
    sendMessage,
    setMessages,
    addToolResult,
    regenerate,
    status,
    error,
    stop,
  } = useChat({
    transport,
    sendAutomaticallyWhen: ({ messages: msgs }) => {
      // Re-submit when the assistant turn ends in resolved tool calls (no text
      // after the last one). Wait for ALL parallel tool calls to resolve first,
      // otherwise the model gets an orphaned tool call and the request errors.
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== "assistant") return false;
      let lastToolIdx = -1;
      let hasUnresolvedTool = false;
      for (let i = 0; i < last.parts.length; i++) {
        if (!last.parts[i].type.startsWith("tool-")) continue;
        lastToolIdx = i;
        const state = (last.parts[i] as { state?: string }).state;
        if (state !== "output-available" && state !== "output-error") {
          hasUnresolvedTool = true;
        }
      }
      if (lastToolIdx === -1 || hasUnresolvedTool) return false;
      for (let i = lastToolIdx + 1; i < last.parts.length; i++) {
        const p = last.parts[i] as { type: string; text?: string };
        if (p.type === "text" && p.text?.trim()) return false;
      }
      return true;
    },
    /**
     * onToolCall MUST return quickly: awaiting addToolResult here would
     * deadlock the SDK's job queue. Fire-and-forget the async work; the
     * result lands after the stream's tool-call step finishes.
     */
    onToolCall({ toolCall }) {
      void runTool(toolCall as ToolCall);
    },
  });

  useEffect(() => {
    addToolResultRef.current = addToolResult as unknown as AddResultFn;
  }, [addToolResult]);

  // Abort the in-flight generation when this chat unmounts (SPA navigation).
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);
  useEffect(() => () => void stopRef.current(), []);

  // "Ask Trellis" handoff from a feed row (desktop rail vs mobile sheet: the
  // visible pane claims the question).
  const sendRef = useRef(sendMessage);
  useEffect(() => {
    sendRef.current = sendMessage;
  }, [sendMessage]);
  useEffect(() => {
    if (!surface) return;
    return subscribeAskTrellis(() => {
      const isDesktop = window.matchMedia("(min-width: 768px)").matches;
      const mine = isDesktop ? surface === "rail" : surface === "sheet";
      if (!mine) return;
      const text = takePendingAsk();
      if (text) sendRef.current({ text });
    });
  }, [surface]);

  // ── Client-side tool execution ─────────────────────────────────────────

  async function runTool(toolCall: ToolCall) {
    const addResult = addToolResultRef.current;
    if (!addResult) return;
    const respond = (output: unknown) =>
      addResult({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output });
    try {
      switch (toolCall.toolName) {
        case "getBalances":
          return await respond(await runGetBalances(toolCall.input));
        case "getLendingPosition":
          return await respond(await runGetLendingPosition(toolCall.input));
        case "getLendingMarkets":
          return await respond(await runGetLendingMarkets(toolCall.input));
        case "getTokenPrice":
          return await respond(await runGetTokenPrice(toolCall.input));
        case "searchToken":
          return await respond(await runSearchToken(toolCall.input));
        case "executePlan":
          return await respond(await runExecutePlan(toolCall));
        case "proposeVaultActions":
          return await respond(await runProposeVault(toolCall));
        case "proposePolicy":
          return await respond(runProposePolicy(toolCall.input));
        case "getVault":
          return await respond(await runGetVault(toolCall.input));
        case "fundFromChain":
          return await respond(await runFundFromChain(toolCall.input));
        case "explainConcept": {
          const { key } = toolCall.input as { key: string };
          const text = getGlossary(key);
          return await respond(
            text ? { key, text } : { error: `Unknown glossary key: ${key}` },
          );
        }
        default:
          return await respond({
            error: `Tool ${toolCall.toolName} is not available in this build.`,
          });
      }
    } catch (e) {
      await respond({ error: errMsg(e) });
    }
  }

  /** Cross-chain funding card: resolves where funds can go (vault and/or wallet). */
  async function runFundFromChain(input: unknown) {
    const i = (input ?? {}) as { target?: "vault" | "wallet"; originSymbol?: string; originChain?: string; amount?: string; destinationSymbol?: string };
    const accountId = accountRef.current;
    if (!accountId) return { error: "Connect a NEAR wallet first (button top-right): funds need a NEAR account to arrive in." };
    const v = await fetchVaultOwner(accountId).catch(() => null);
    const vault = v?.vaultId ? { id: v.vaultId, label: "your vault", kind: "vault" as const } : null;
    const wallet = { id: accountId, label: "your wallet", kind: "wallet" as const };
    const targets = i.target === "wallet" || !vault ? [wallet, ...(vault ? [vault] : [])] : [vault, wallet];
    return {
      shown: true,
      targets,
      prefill: { originSymbol: i.originSymbol, originChain: i.originChain, amount: i.amount, destinationSymbol: i.destinationSymbol },
      note: `Card shown. Funds go to ${targets[0].id}${vault ? "" : " (no vault yet)"}; the user fills in their refund address and sends from their other wallet.`,
    };
  }

  /** Resolves the account a read targets: explicit id, else the connected one. */
  function targetAccount(input: unknown): { id: string } | { error: string } {
    const raw = ((input ?? {}) as { accountId?: string }).accountId?.trim().toLowerCase();
    const id = raw || accountRef.current || "";
    if (!id) {
      return {
        error:
          "No wallet connected and no account given. Ask the user to connect a NEAR wallet (button top-right) or name an account like alice.near.",
      };
    }
    if (!isValidAccountId(id)) return { error: `"${id}" is not a valid NEAR account id.` };
    return { id };
  }

  async function runGetBalances(input: unknown) {
    const t = targetAccount(input);
    if ("error" in t) return t;
    const b = await fetchBalances(t.id);
    if (!b.exists) return { error: `Account ${t.id} does not exist on NEAR.` };
    rememberIcons(b.balances);
    return pruneForModel({
      accountId: b.accountId,
      totalUsd: r(b.totalUsd, 2),
      storageLockedNear: r(b.storageLockedNear),
      balances: b.balances.map((x) => ({
        tokenId: x.tokenId,
        symbol: x.symbol,
        balance: floorToDecimals(x.balance, 6),
        priceUsd: r(x.priceUsd, 6),
        valueUsd: r(x.valueUsd, 2),
        verified: x.verified,
      })),
    });
  }

  async function runGetLendingPosition(input: unknown) {
    const t = targetAccount(input);
    if ("error" in t) return t;
    const position = await fetchPosition(t.id);
    return { position: pruneForModel(position) };
  }

  async function runGetLendingMarkets(input: unknown) {
    const { token, limit = 10 } = (input ?? {}) as { token?: string; limit?: number };
    let markets = await cachedMarkets();
    if (token?.trim()) {
      const q = token.trim().toLowerCase();
      const id = KNOWN_SYMBOLS[q] ?? q;
      markets = markets.filter(
        (m) => m.tokenId === id || m.symbol.toLowerCase() === q,
      );
    }
    return {
      markets: markets.slice(0, Math.max(1, Math.min(25, limit))).map((m) => ({
        ...m,
        supplyAprPct: r(m.supplyAprPct, 2)!,
        borrowAprPct: r(m.borrowAprPct, 2)!,
        utilizationPct: r(m.utilizationPct, 1)!,
        totalSupplied: r(m.totalSupplied, 2)!,
        totalBorrowed: r(m.totalBorrowed, 2)!,
        availableLiquidity: r(m.availableLiquidity, 2)!,
        totalSuppliedUsd: r(m.totalSuppliedUsd, 0),
        availableLiquidityUsd: r(m.availableLiquidityUsd, 0),
        priceUsd: r(m.priceUsd, 6),
      })),
    };
  }

  async function runGetTokenPrice(input: unknown) {
    const { tokens = [] } = (input ?? {}) as { tokens?: string[] };
    const resolved: { query: string; tokenId?: string; note?: string }[] = [];
    for (const raw of tokens.slice(0, 10)) {
      const q = raw.trim().toLowerCase();
      if (KNOWN_SYMBOLS[q]) {
        resolved.push({ query: raw, tokenId: KNOWN_SYMBOLS[q] });
      } else if (looksLikeAccountId(q)) {
        resolved.push({ query: raw, tokenId: q });
      } else {
        const hits = await fetchTokenSearch(q);
        rememberIcons(hits);
        const best = hits.find((h) => h.verified) ?? hits[0];
        resolved.push({
          query: raw,
          tokenId: best?.id,
          note: !best
            ? "no token found"
            : !best.verified
              ? "only an unverified match; confirm with searchToken"
              : hits.filter((h) => h.symbol.toLowerCase() === q && h.verified).length > 1
                ? "several verified tokens share this symbol; picked the top match"
                : undefined,
        });
      }
    }
    const ids = resolved.flatMap((x) => (x.tokenId ? [x.tokenId] : []));
    const rows = ids.length ? await fetchPrices(ids) : [];
    const byId = new Map(rows.map((x) => [x.tokenId, x]));
    return pruneForModel({
      source: "Ref indexer, display only",
      prices: resolved.map((x) => {
        const row = x.tokenId ? byId.get(x.tokenId) : undefined;
        return {
          query: x.query,
          tokenId: x.tokenId ?? x.query,
          symbol: row?.symbol ?? x.query.toUpperCase(),
          priceUsd: r(row?.priceUsd, 6),
          verified: row?.verified ?? false,
          note: x.note,
        };
      }),
    });
  }

  async function runSearchToken(input: unknown) {
    const { query = "" } = (input ?? {}) as { query?: string };
    const hits = await fetchTokenSearch(query);
    rememberIcons(hits);
    return pruneForModel({
      query,
      results: hits.map((h) => ({
        tokenId: h.id,
        symbol: h.symbol,
        name: h.name,
        decimals: h.decimals,
        priceUsd: r(h.priceUsd, 6),
        verified: h.verified,
      })),
    });
  }

  /** Compact view of a built plan for the model (the card has the full plan). */
  function planForModel(plan: WalletPlan | VaultPlan) {
    return pruneForModel({
      mode: plan.mode,
      summary: plan.summary,
      steps: plan.steps.map((s) => s.label),
      transactions: plan.mode === "wallet" ? plan.txs.length : undefined,
      agentActions: plan.mode === "vault" ? plan.calls.length : undefined,
      healthBefore: plan.healthBefore,
      healthAfter: plan.healthAfter,
      guardian: plan.guardian.map((g) => `${g.level}: ${g.title}`),
      blocked: plan.blocked,
      status: plan.mode === "wallet" ? "built, waiting for the user to sign" : "proposed, waiting for the owner to approve",
    });
  }

  async function runExecutePlan(toolCall: ToolCall) {
    const accountId = accountRef.current;
    if (!accountId) return { error: "No wallet connected. Ask the user to connect a NEAR wallet first." };
    const input = (toolCall.input ?? {}) as { steps?: unknown[]; risks?: unknown[] };
    const { plan } = await postJson<{ plan: WalletPlan }>("/api/plan/build", {
      accountId,
      steps: input.steps,
      risks: input.risks,
    });
    planCache.set(toolCall.toolCallId, { plan });
    return planForModel(plan);
  }

  async function runProposeVault(toolCall: ToolCall) {
    const accountId = accountRef.current;
    if (!accountId) return { error: "No wallet connected. The vault owner must connect their wallet." };
    const input = (toolCall.input ?? {}) as { steps?: unknown[]; risks?: unknown[]; reasoning?: string };
    const { plan, approval } = await postJson<{ plan: VaultPlan; approval: VaultApproval }>("/api/vault/preview", {
      accountId,
      steps: input.steps,
      risks: input.risks,
      reasoning: input.reasoning,
    });
    planCache.set(toolCall.toolCallId, { plan, approval });
    return planForModel(plan);
  }

  function runProposePolicy(input: unknown) {
    const i = (input ?? {}) as {
      preset?: "careful" | "balanced";
      targetLeverage?: number;
      minHealthFactor?: number;
      maxSlippagePct?: number;
      tokens?: string[];
      limits?: { token: string; perAction: number; daily: number }[];
      agentExpiryDays?: number;
    };
    const base = PRESETS[i.preset ?? "balanced"];
    const idOf = (sym: string) => VAULT_TOKENS.find((t) => t.symbol === sym)?.id;
    const form: RulesForm = {
      ...base,
      preset: i.preset ?? "balanced",
      perAction: { ...base.perAction },
      daily: { ...base.daily },
    };
    if (i.targetLeverage) form.targetLeverage = i.targetLeverage;
    if (i.minHealthFactor) {
      form.minHf = i.minHealthFactor;
      form.deleverageTrigger = Math.max(1.1, Math.round((i.minHealthFactor - 0.15) * 100) / 100);
      form.emergencyFloor = Math.max(1.05, Math.round((form.deleverageTrigger - 0.15) * 100) / 100);
    }
    if (i.maxSlippagePct) form.maxSlippagePct = i.maxSlippagePct;
    if (i.tokens?.length) form.tokens = i.tokens.map(idOf).filter((x): x is NonNullable<typeof x> => !!x);
    for (const l of i.limits ?? []) {
      const id = idOf(l.token);
      if (!id) continue;
      form.perAction[id] = l.perAction;
      form.daily[id] = l.daily;
    }
    if (i.agentExpiryDays !== undefined) form.agentExpiryDays = i.agentExpiryDays;
    if (i.targetLeverage || i.minHealthFactor || i.tokens || i.limits || i.maxSlippagePct) form.preset = "custom";
    const errors = validateRules(form);
    return {
      preset: form.preset,
      summary: rulesSummary(form),
      errors,
      link: `/vault/setup?rules=${encodeRules(form)}`,
      status: "prefilled form; the owner reviews and saves it with one wallet signature",
    };
  }

  async function runGetVault(input: unknown) {
    const t = targetAccount(input && typeof input === "object" ? { accountId: (input as { owner?: string }).owner } : {});
    if ("error" in t) return t;
    const info = await fetchVaultOwner(t.id);
    if (!info.vaultId) {
      return { exists: false, owner: t.id, setupLink: "/vault/setup", note: "No vault yet. It takes one signature to create." };
    }
    const s = await fetchVaultState(info.vaultId);
    rememberIcons(s.balances.balances);
    const decimals = (id: string) => s.tokens.find(([tid]) => tid === id)?.[1].decimals ?? 24;
    return pruneForModel({
      exists: true,
      vaultId: s.vaultId,
      owner: s.status.owner,
      agent: s.status.agent,
      agentExpiresAt: s.status.agent_expires_at
        ? new Date(Number(BigInt(s.status.agent_expires_at) / BigInt(1e6))).toISOString()
        : undefined,
      paused: s.status.paused,
      operationInFlight: s.status.in_flight ? `${s.status.in_flight.kind} #${s.status.in_flight.op_id}` : undefined,
      protocolsReady: s.protocolsReady,
      rules: s.policy
        ? {
            allowedTokens: s.policy.allowed_tokens,
            allowedPools: s.policy.allowed_ref_pools,
            minHealthFactor: s.policy.min_health_factor_bps / 10000,
            deleverageTrigger: s.policy.deleverage_trigger_bps / 10000,
            maxSlippagePct: s.policy.max_slippage_bps / 100,
            limitsLeftToday: Object.fromEntries(
              Object.entries(s.remaining).map(([id, raw]) => [id, r(Number(BigInt(raw)) / 10 ** decimals(id), 4)]),
            ),
          }
        : undefined,
      balances: s.balances.balances
        .filter((b) => b.verified)
        .map((b) => ({ tokenId: b.tokenId, symbol: b.symbol, balance: floorToDecimals(b.balance, 6), valueUsd: r(b.valueUsd, 2) })),
      position: {
        healthFactor: s.position.healthFactor,
        collateral: s.position.collateral.map((l) => `${r(l.amount, 4)} ${l.symbol}`),
        borrowed: s.position.borrowed.map((l) => `${r(l.amount, 4)} ${l.symbol}`),
        netValueUsd: r(s.position.netValueUsd, 2),
        liquidation: s.position.liquidationPrices.map((x) => `${x.symbol} at $${r(x.liquidationPriceUsd, 4)} (${r(x.dropPct, 1)}% drop)`),
      },
      lastRecordedHealth: hfFromBps(s.status.last_health?.health_factor_bps),
      recentActions: s.receipts.slice(0, 10).map((x) => ({
        what: receiptText(x),
        status: x.status,
        when: receiptAgo(x),
        note: x.note || undefined,
      })),
    });
  }

  // ── Render ────────────────────────────────────────────────────────────

  const [draft, setDraft] = useState("");
  function submit(text: string) {
    if (!text.trim()) return;
    void sendMessage({ text });
    setDraft("");
    setSignError(null);
  }

  // Clicking the navbar logo wipes this session back to the hero.
  useRegisterChatReset(() => {
    void stop();
    setMessages([]);
    setDraft("");
    setSignError(null);
  });

  if (messages.length === 0) {
    if (embedded) {
      return (
        <EmbeddedEmpty
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submit}
          model={selectedModel}
          onModelChange={setSelectedModel}
        />
      );
    }
    return (
      <IdleHero
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submit}
        model={selectedModel}
        onModelChange={setSelectedModel}
      />
    );
  }

  const isStreaming = status === "streaming" || status === "submitted";
  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();

  const body = (
    <div
      className={cn(
        "flex flex-col",
        // Embedded in a flex-row rail: stretch to fill the parent.
        embedded ? "h-full w-full min-w-0" : "h-dvh",
      )}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className={cn("min-h-0 flex-1 overflow-y-auto", !embedded && "pt-16")}
        >
          <div
            ref={contentRef}
            className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-4 pb-3 sm:px-6"
          >
            {messages.map((m, i) => {
              const isLastAssistant = i === lastAssistantIdx;
              return (
                <AgentMessage
                  key={m.id}
                  message={m}
                  isStreaming={isStreaming && isLastAssistant}
                  canRegenerate={isLastAssistant && !isStreaming}
                  onRegenerate={() => void regenerate()}
                  iconLookup={iconFor}
                  accountId={accountId}
                  onAskAgent={(text) => void sendMessage({ text })}
                />
              );
            })}

            {status === "submitted" && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="surface-card inline-flex items-center gap-2.5 self-start px-3.5 py-2 text-body-sm font-medium rounded-card"
                role="status"
                aria-label="Trellis is thinking"
              >
                <LiquidBlob size={20} />
                <span className="shimmer-text">Thinking…</span>
              </motion.div>
            )}

            {signError && (
              <ErrorBanner
                message={signError}
                onAskAgent={(prompt) => {
                  setSignError(null);
                  void sendMessage({ text: prompt });
                }}
                onDismiss={() => setSignError(null)}
              />
            )}

            {error && (
              <div className="bg-destructive/15 px-4 py-3 text-body-sm text-destructive rounded-card">
                {friendlyChatError(error.message)}
              </div>
            )}
          </div>
        </div>

        <AnimatePresence>
          {escapedFromLock && !isAtBottom && (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 8, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.9 }}
              transition={SPRING_BOUNCY}
              onClick={() => void scrollToBottom()}
              aria-label="Scroll to bottom"
              className="absolute bottom-3 left-1/2 z-10 inline-flex size-9 -translate-x-1/2 items-center justify-center surface-card text-muted-ash shadow-header transition-colors hover:text-midnight-ink rounded-full"
            >
              <ChevronDown className="size-4" strokeWidth={2.4} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <div className="shrink-0">
        <div className="mx-auto w-full max-w-4xl px-4 py-4 sm:px-6">
          <ChatInput
            value={draft}
            onChange={setDraft}
            onSubmit={() => submit(draft)}
            disabled={isStreaming}
            placeholder={isStreaming ? "trellis is thinking…" : "what do you want to do?"}
            model={selectedModel}
            onModelChange={setSelectedModel}
          />
        </div>
      </div>
    </div>
  );

  return embedded ? body : <CinematicShell mode="dim">{body}</CinematicShell>;
}

/** The chat route returns JSON errors (e.g. missing NEARAI_API_KEY). */
function friendlyChatError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // not JSON
  }
  return raw;
}

function EmbeddedEmpty({
  draft,
  onDraftChange,
  onSubmit,
  model,
  onModelChange,
}: {
  draft: string;
  onDraftChange: (v: string) => void;
  onSubmit: (text: string) => void;
  model?: string;
  onModelChange?: (id: string) => void;
}) {
  return (
    <div className="flex h-full w-full min-w-0 flex-col items-center justify-center px-5">
      <div className="w-full max-w-2xl space-y-4">
        <div className="text-center">
          <h2 className="font-alt text-body-lg font-medium tracking-tight text-midnight-ink">
            Ask Trellis
          </h2>
          <p className="mt-1 text-body-sm text-muted-ash">
            Balances, Rhea positions, health factor, rates.
          </p>
        </div>
        <ChatInput
          value={draft}
          onChange={onDraftChange}
          onSubmit={() => onSubmit(draft)}
          placeholder="what do you want to do?"
          model={model}
          onModelChange={onModelChange}
        />
        <ExamplePrompts onPick={onSubmit} />
      </div>
    </div>
  );
}

function IdleHero({
  draft,
  onDraftChange,
  onSubmit,
  model,
  onModelChange,
}: {
  draft: string;
  onDraftChange: (v: string) => void;
  onSubmit: (text: string) => void;
  model?: string;
  onModelChange?: (id: string) => void;
}) {
  return (
    <CinematicShell mode="bright">
      <div className="relative z-20 mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          whileHover={{ scale: 1.03 }}
          transition={{ type: "spring", visualDuration: 0.6, bounce: 0.1, delay: 0.08 }}
          className="mb-5 inline-flex"
        >
          <LiveMainnetBadge />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", visualDuration: 0.7, bounce: 0.15, delay: 0.15 }}
          className="font-alt display-tight max-w-[1100px] text-center font-medium leading-[1.05] tracking-tight text-midnight-ink text-[clamp(40px,5.4vw,72px)]"
        >
          <span className="block">Set the rules.</span>
          <span className="block">
            <span className="text-gradient-trellis font-semibold">Trellis</span>{" "}
            grows it on <span className="text-gradient-near font-semibold">NEAR</span>.
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", visualDuration: 0.7, bounce: 0.1, delay: 0.3 }}
          className="mt-5 max-w-3xl text-center text-body text-pretty text-muted-ash"
        >
          Ask in plain English. Trellis reads your NEAR wallet and Rhea Lending
          position, plans the swaps and loans, and its{" "}
          <span className="font-alt font-medium text-midnight-ink">Risk Guardian</span>{" "}
          shows every risk before you sign. In a vault, the agent can only act{" "}
          <span className="font-alt font-medium text-midnight-ink">
            inside rules a smart contract enforces
          </span>
          .
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", visualDuration: 0.7, bounce: 0.15, delay: 0.4 }}
          className="mt-8 w-full max-w-2xl space-y-4"
        >
          <ChatInput
            value={draft}
            onChange={onDraftChange}
            onSubmit={() => onSubmit(draft)}
            autoFocus
            placeholder="what do you want to do?"
            model={model}
            onModelChange={onModelChange}
          />
          <ExamplePrompts onPick={onSubmit} />
        </motion.div>

        <div className="mt-7">
          <HeroStatStrip />
        </div>
      </div>
    </CinematicShell>
  );
}

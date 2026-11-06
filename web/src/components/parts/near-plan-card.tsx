"use client";

// Plan card (frontend-spec §4.2): steps, Guardian, readable transaction viewer,
// sign/status, mode badge (Wallet / Vault), a transaction list with
// per-transaction status, partial-failure state + retry (§3.2), and vault
// approval with live worker progress (§3.4).

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  AlertTriangle,
  Bot,
  Check,
  ExternalLink,
  Eye,
  Loader2,
  RotateCcw,
  Wallet,
  X,
} from "lucide-react";
import { GuardianPanel } from "@/components/parts/guardian-panel";
import { TxViewerDialog } from "@/components/parts/tx-viewer-dialog";
import { MoneyFlowGraph } from "@/components/parts/money-flow";
import { buildMoneyFlow } from "@/lib/flow-model";
import { PillButton } from "@/components/ui/pill-button";
import { StatusDisk } from "@/components/ui/status-disk";
import { Tag } from "@/components/ui/tag";
import { signedFetch } from "@/lib/api-client";
import { explorerTxUrl } from "@/lib/near/config";
import { contractLabel } from "@/lib/near/decode";
import { useSignTxs, type TxResult } from "@/lib/near/wallet-tx";
import { useTrellisSession } from "@/lib/near/use-session";
import type { BuiltPlan, VaultPlan, WalletPlan } from "@/lib/ai/plan-types";
import { cn } from "@/lib/utils";

export type VaultApproval = { token: string; planId: string; expiresAt: number };

type TxState = "idle" | "pending" | "success" | "failed";

export function NearPlanCard({
  plan,
  approval,
  accountId,
  onAskAgent,
}: {
  plan: BuiltPlan;
  approval?: VaultApproval;
  accountId: string | null;
  onAskAgent: (text: string) => void;
}) {
  const vault = plan.mode === "vault";
  const flow = useMemo(
    () => buildMoneyFlow(plan.steps, { mode: plan.mode, healthBefore: plan.healthBefore, healthAfter: plan.healthAfter }),
    [plan],
  );
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", visualDuration: 0.35, bounce: 0.18 }}
      className="surface-card max-w-[620px] space-y-3 p-3 rounded-card"
    >
      <div className="flex items-center gap-2.5 px-1 pt-1">
        <StatusDisk tone={vault ? "green" : "neutral"} className="size-8">
          {vault ? <Bot className="size-4" strokeWidth={2.4} /> : <Wallet className="size-4" strokeWidth={2.4} />}
        </StatusDisk>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-caption font-medium uppercase tracking-wider text-muted-ash">
            {vault ? `Vault plan · ${plan.vaultId}` : "Wallet plan · you sign"}
          </div>
          <div className="text-body-sm font-medium text-midnight-ink">
            {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
            {vault ? ` · ${plan.calls.length} agent action${plan.calls.length === 1 ? "" : "s"}` : ` · ${plan.txs.length} transaction${plan.txs.length === 1 ? "" : "s"}`}
          </div>
        </div>
        <Tag tone={vault ? "green" : "neutral"}>{vault ? "Vault" : "Wallet"}</Tag>
      </div>

      <MoneyFlowGraph flow={flow} height={plan.steps.length > 3 ? 280 : 230} />

      <ol className="space-y-1">
        {plan.steps.map((s, i) => (
          <li key={s.id} className="flex items-start gap-2.5 surface-panel px-3 py-2 rounded-card">
            <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-midnight-ink/[0.06] text-[11px] font-medium tabular-nums text-midnight-ink">
              {i + 1}
            </span>
            <span className="text-body-sm text-midnight-ink">{s.label}</span>
          </li>
        ))}
      </ol>

      <GuardianPanel risks={plan.guardian} />

      {vault ? (
        <VaultSection plan={plan} approval={approval} accountId={accountId} onAskAgent={onAskAgent} />
      ) : (
        <WalletSection plan={plan} accountId={accountId} onAskAgent={onAskAgent} />
      )}
    </motion.div>
  );
}

// ── Wallet mode: transaction list, Sign, per-tx status, partial failure ──

function WalletSection({
  plan,
  accountId,
  onAskAgent,
}: {
  plan: WalletPlan;
  accountId: string | null;
  onAskAgent: (text: string) => void;
}) {
  const sign = useSignTxs();
  const [states, setStates] = useState<TxState[]>(() => plan.txs.map(() => "idle"));
  const [results, setResults] = useState<(TxResult | undefined)[]>(() => plan.txs.map(() => undefined));
  const [error, setError] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const busy = states.includes("pending");
  const firstOpen = states.findIndex((s) => s !== "success");
  const done = firstOpen === -1;
  const failedIdx = states.findIndex((s) => s === "failed");
  const wrongAccount = !!accountId && accountId !== plan.accountId;

  async function run(from: number) {
    setError(null);
    const slice = plan.txs.slice(from);
    setStates((st) => st.map((s, i) => (i >= from ? "pending" : s)));
    try {
      const res = await sign(slice);
      setResults((r) => r.map((x, i) => (i >= from ? res[i - from] : x)));
      setStates((st) => st.map((s, i) => (i >= from ? (res[i - from]?.ok ? "success" : "failed") : s)));
    } catch (e) {
      // Rejected in the wallet, or the wallet threw mid-way: we can't tell
      // which (if any) went through, so leave them retryable.
      setStates((st) => st.map((s, i) => (i >= from ? "idle" : s)));
      setError((e as Error).message || "The wallet didn't send the transactions.");
    }
  }

  const landed = states.filter((s) => s === "success").length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-ash">Transactions</span>
        <button
          type="button"
          onClick={() => setViewerOpen(true)}
          className="inline-flex items-center gap-1 text-caption font-medium text-muted-ash transition-colors hover:text-midnight-ink"
        >
          <Eye className="size-3.5" strokeWidth={2.2} /> View details
        </button>
      </div>
      <ul className="space-y-1">
        {plan.txs.map((tx, i) => (
          <li key={i} className="flex items-center gap-2.5 surface-panel px-3 py-2 rounded-card">
            <TxDot state={states[i]} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-body-sm text-midnight-ink">
                <span className="text-muted-ash">Tx {i + 1}:</span> {tx.label}
              </div>
              <div className="truncate text-caption text-muted-ash">
                {contractLabel(tx.receiverId)} · {tx.actions.length} action{tx.actions.length === 1 ? "" : "s"}
                {results[i]?.error ? ` · ${results[i]!.error}` : ""}
              </div>
            </div>
            {results[i]?.hash && (
              <a
                href={explorerTxUrl(results[i]!.hash!)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-caption font-medium text-muted-ash hover:text-midnight-ink"
              >
                NearBlocks <ExternalLink className="size-3" />
              </a>
            )}
          </li>
        ))}
      </ul>

      {failedIdx >= 0 && (
        <div className="flex items-start gap-2 bg-warning/15 px-3 py-2.5 text-body-sm text-midnight-ink rounded-card">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
          <span>
            {landed > 0
              ? `${landed} of ${plan.txs.length} transactions went through. Tx ${failedIdx + 1} failed, so the steps after it didn't happen. Your funds are in your wallet; nothing is stuck.`
              : `Tx ${failedIdx + 1} failed. Nothing after it happened.`}
          </span>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 bg-destructive/12 px-3 py-2.5 text-body-sm text-midnight-ink rounded-card">
          <X className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
          <span>{error}</span>
        </div>
      )}
      {done && (
        <div className="flex items-center gap-2 bg-deliver-green/15 px-3 py-2.5 text-body-sm text-midnight-ink rounded-card">
          <Check className="size-4" strokeWidth={2.4} /> All {plan.txs.length} transactions landed.
        </div>
      )}

      {!done && (
        <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
          {!accountId ? (
            <span className="text-body-sm text-muted-ash">Connect your wallet to sign.</span>
          ) : wrongAccount ? (
            <span className="text-body-sm text-muted-ash">
              This plan was built for {plan.accountId}. Ask Trellis to rebuild it for {accountId}.
            </span>
          ) : (
            <PillButton disabled={busy || plan.blocked} onClick={() => void run(Math.max(0, firstOpen))}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" strokeWidth={2.4} />}
              {busy
                ? "Waiting for wallet…"
                : failedIdx >= 0 || landed > 0
                  ? `Retry from Tx ${firstOpen + 1}`
                  : plan.txs.length > 1
                    ? `Sign ${plan.txs.length} transactions`
                    : "Sign"}
            </PillButton>
          )}
          {(failedIdx >= 0 || landed > 0) && (
            <PillButton
              variant="secondary"
              disabled={busy}
              onClick={() =>
                onAskAgent(
                  `Tx ${firstOpen + 1} of my plan didn't go through${results[firstOpen]?.error ? ` (${results[firstOpen]!.error})` : ""}. Check my balances and rebuild the remaining steps.`,
                )
              }
            >
              <RotateCcw className="size-3.5" strokeWidth={2.4} /> Rebuild the rest
            </PillButton>
          )}
          {plan.blocked && <span className="text-caption text-muted-ash">Resolve the Guardian blocks first.</span>}
        </div>
      )}

      <TxViewerDialog open={viewerOpen} onOpenChange={setViewerOpen} txs={plan.txs} signer={plan.accountId} />
    </div>
  );
}

function TxDot({ state }: { state: TxState }) {
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
        state === "idle" && "bg-midnight-ink/[0.06]",
        state === "pending" && "bg-warning/30",
        state === "success" && "bg-deliver-green text-midnight-ink",
        state === "failed" && "bg-destructive text-canvas-white",
      )}
    >
      {state === "pending" && <Loader2 className="size-3 animate-spin" />}
      {state === "success" && <Check className="size-3" strokeWidth={3} />}
      {state === "failed" && <X className="size-3" strokeWidth={3} />}
    </span>
  );
}

// ── Vault mode: Approve (no wallet popup) → worker → live step status ──

type WorkerPlanView = {
  status: "queued" | "running" | "done" | "failed";
  steps: { label: string; method: string; status: "pending" | "running" | "done" | "failed"; txHash?: string; note?: string }[];
  error?: string;
};

function VaultSection({
  plan,
  approval,
  accountId,
  onAskAgent,
}: {
  plan: VaultPlan;
  approval?: VaultApproval;
  accountId: string | null;
  onAskAgent: (text: string) => void;
}) {
  const { ensure } = useTrellisSession(accountId);
  const [phase, setPhase] = useState<"idle" | "approving" | "submitted">("idle");
  const [planId, setPlanId] = useState<string | null>(null);
  const [live, setLive] = useState<WorkerPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const isOwner = accountId === plan.owner;

  useEffect(() => {
    if (phase !== "idle") return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [phase]);
  const expired = !approval || now > approval.expiresAt;

  useEffect(() => {
    if (!planId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await signedFetch(`/api/vault/plans?id=${encodeURIComponent(planId)}`, { cache: "no-store" });
        const j = await r.json();
        if (!stopped) {
          if (r.ok) setLive(j as WorkerPlanView);
          else setError(j.error ?? `HTTP ${r.status}`);
          const st = (j as WorkerPlanView).status;
          if (st === "done" || st === "failed") return;
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [planId]);

  async function approve() {
    if (!approval) return;
    setError(null);
    setPhase("approving");
    try {
      await ensure();
      const r = await signedFetch("/api/vault/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: approval.token }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setPlanId(j.planId);
      setPhase("submitted");
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  const steps = live?.steps ?? plan.calls.map((c) => ({ label: c.label, method: c.method, status: "pending" as const }));

  return (
    <div className="space-y-2">
      <div className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-ash">
        Agent actions (checked again by your vault)
      </div>
      <ul className="space-y-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2.5 surface-panel px-3 py-2 rounded-card">
            <TxDot state={s.status === "done" ? "success" : s.status === "failed" ? "failed" : s.status === "running" ? "pending" : "idle"} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-body-sm text-midnight-ink">{s.label}</div>
              <div className="truncate font-mono text-caption text-muted-ash">
                {s.method}
                {"note" in s && s.note ? ` · ${s.note}` : ""}
              </div>
            </div>
            {"txHash" in s && s.txHash && (
              <a
                href={explorerTxUrl(s.txHash)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-caption font-medium text-muted-ash hover:text-midnight-ink"
              >
                NearBlocks <ExternalLink className="size-3" />
              </a>
            )}
          </li>
        ))}
      </ul>

      {live?.status === "failed" && (
        <div className="flex items-start gap-2 bg-warning/15 px-3 py-2.5 text-body-sm text-midnight-ink rounded-card">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
          <span>
            The vault stopped the plan{live.error ? `: ${live.error}` : "."} Steps before it stay done; nothing after it ran.
          </span>
        </div>
      )}
      {live?.status === "done" && (
        <div className="flex items-center gap-2 bg-deliver-green/15 px-3 py-2.5 text-body-sm text-midnight-ink rounded-card">
          <Check className="size-4" strokeWidth={2.4} /> Done. Every step settled inside your rules.
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 bg-destructive/12 px-3 py-2.5 text-body-sm text-midnight-ink rounded-card">
          <X className="mt-0.5 size-4 shrink-0" strokeWidth={2.4} />
          <span>{error}</span>
        </div>
      )}

      {phase !== "submitted" && (
        <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
          {!accountId ? (
            <span className="text-body-sm text-muted-ash">Connect the vault owner&apos;s wallet to approve.</span>
          ) : !isOwner ? (
            <span className="text-body-sm text-muted-ash">Only {plan.owner} can approve this plan.</span>
          ) : expired ? (
            <>
              <span className="text-body-sm text-muted-ash">This proposal expired (5 minutes).</span>
              <PillButton variant="secondary" onClick={() => onAskAgent("Rebuild that vault plan with fresh numbers.")}>
                <RotateCcw className="size-3.5" strokeWidth={2.4} /> Rebuild
              </PillButton>
            </>
          ) : (
            <PillButton disabled={phase === "approving" || plan.blocked} onClick={() => void approve()}>
              {phase === "approving" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" strokeWidth={2.4} />}
              {phase === "approving" ? "Approving…" : "Approve"}
            </PillButton>
          )}
          {plan.blocked && <span className="text-caption text-muted-ash">The vault would reject this plan; see the Guardian.</span>}
        </div>
      )}
      {phase === "submitted" && !live && (
        <div className="flex items-center gap-2 px-1 text-body-sm text-muted-ash">
          <Loader2 className="size-4 animate-spin" /> Queued for the agent…
        </div>
      )}
    </div>
  );
}

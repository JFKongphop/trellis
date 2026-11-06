"use client";

// "While you were away": automatic protection moves the owner hasn't seen yet.
// Per-browser "last seen" lives in localStorage; without it we show the last 24 h.

import { useMemo, useState } from "react";
import { ChevronDown, Zap, X } from "lucide-react";
import { hfFromBps, type VaultReceipt } from "@/lib/near/vault";
import { receiptAgo, receiptMove, receiptText } from "@/lib/near/receipt-text";
import { MoneyFlowGraph } from "@/components/parts/money-flow";
import { buildMoneyFlow, stepsFromMoves } from "@/lib/flow-model";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const key = (vaultId: string) => `trellis:lastSeen:${vaultId}`;

function readLastSeen(vaultId: string): number {
  try {
    const v = Number(window.localStorage.getItem(key(vaultId)));
    if (Number.isFinite(v) && v > 0) return v;
  } catch {
    // storage blocked: fall through
  }
  return Date.now() - DAY_MS;
}

const receiptMs = (r: VaultReceipt) => Number(BigInt(r.timestamp) / BigInt(1_000_000));
const fmtHf = (bps: string | null | undefined) => {
  const v = bps ? hfFromBps(bps) : null;
  return v === null ? "∞" : v.toFixed(2);
};

export function AwayBanner({ vaultId, receipts, currentHf }: { vaultId: string; receipts: VaultReceipt[]; currentHf: number | null }) {
  const [lastSeen, setLastSeen] = useState(() => readLastSeen(vaultId));
  const [showFlow, setShowFlow] = useState(true);

  // receipts are newest first
  const moves = receipts.filter((r) => r.origin === "auto" && receiptMs(r) > lastSeen);
  const flow = useMemo(() => {
    const oldestFirst = [...moves].reverse().filter((m) => m.status === "Settled");
    const hfBefore = oldestFirst[0]?.hf_before_bps ? hfFromBps(oldestFirst[0].hf_before_bps) : undefined;
    return buildMoneyFlow(stepsFromMoves(oldestFirst.map(receiptMove)), { mode: "vault", healthBefore: hfBefore, healthAfter: currentHf });
    // moves is derived from receipts + lastSeen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipts, lastSeen, currentHf]);
  if (moves.length === 0) return null;

  const oldest = moves[moves.length - 1]!;
  const before = oldest.hf_before_bps ? fmtHf(oldest.hf_before_bps) : null;
  const after = currentHf === null ? "∞" : currentHf.toFixed(2);
  const failed = moves.filter((m) => m.status === "Failed").length;

  const dismiss = () => {
    const now = Date.now();
    try {
      window.localStorage.setItem(key(vaultId), String(now));
    } catch {
      // ignore
    }
    setLastSeen(now);
  };

  return (
    <div className="surface-card relative space-y-3 p-4 ring-1 ring-brand-orange/40 rounded-card">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-orange/15 text-brand-orange">
          <Zap className="size-4" strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-body-sm font-medium text-midnight-ink">
            While you were away, Trellis made {moves.length} automatic {moves.length === 1 ? "move" : "moves"} to protect your position
          </div>
          <div className="mt-0.5 text-caption text-muted-ash">
            {before ? (
              <>
                Health factor <span className="tabular-nums text-midnight-ink">{before}</span> →{" "}
                <span className="tabular-nums text-midnight-ink">{after}</span>
              </>
            ) : (
              <>
                Health factor now <span className="tabular-nums text-midnight-ink">{after}</span>
              </>
            )}
            {oldest.why ? ` · ${oldest.why}` : ""}
            {failed > 0 ? ` · ${failed} step${failed === 1 ? "" : "s"} failed and will be retried` : ""}
          </div>
        </div>
        <button type="button" aria-label="Dismiss" onClick={dismiss} className="shrink-0 rounded-full p-1 text-muted-ash hover:text-midnight-ink">
          <X className="size-4" />
        </button>
      </div>
      {flow.edges.length > 0 && (
        <div className="space-y-1.5 pl-12">
          <button
            type="button"
            onClick={() => setShowFlow((v) => !v)}
            className="inline-flex items-center gap-1 text-caption font-medium text-midnight-ink"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", !showFlow && "-rotate-90")} /> Money flow
          </button>
          {showFlow && <MoneyFlowGraph flow={flow} height={210} />}
        </div>
      )}
      <ol className="space-y-1 pl-12">
        {[...moves]
          .reverse()
          .slice(-5)
          .map((m) => (
            <li key={m.op_id} className="flex justify-between gap-2 text-caption">
              <span className={m.status === "Failed" ? "text-destructive" : "text-midnight-ink"}>
                {receiptText(m)}
                {m.status === "Failed" ? " (failed)" : ""}
              </span>
              <span className="shrink-0 text-muted-ash">{receiptAgo(m)}</span>
            </li>
          ))}
      </ol>
      <div className="pl-12">
        <button type="button" onClick={dismiss} className="bg-midnight-ink px-3 py-1.5 text-caption font-medium text-canvas-white rounded-button">
          Got it
        </button>
      </div>
    </div>
  );
}

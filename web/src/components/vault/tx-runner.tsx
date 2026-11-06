"use client";

import { useState } from "react";
import { Check, ExternalLink, Eye, Loader2, X } from "lucide-react";
import { PillButton } from "@/components/ui/pill-button";
import { TxViewerDialog } from "@/components/parts/tx-viewer-dialog";
import { explorerTxUrl } from "@/lib/near/config";
import { useSignTxs, type TxResult } from "@/lib/near/wallet-tx";
import type { NearTx } from "@/lib/near/tx";
import { cn } from "@/lib/utils";

/**
 * Lists owner transactions, signs them with the wallet, shows per-tx results.
 * Used by /vault/setup and the /vault controls (every owner call = 1 yocto).
 */
export function TxRunner({
  txs,
  cta,
  disabled,
  signer,
  onDone,
}: {
  txs: NearTx[];
  cta: string;
  disabled?: boolean;
  signer?: string;
  onDone?: (results: TxResult[]) => void;
}) {
  const sign = useSignTxs();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<TxResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const res = await sign(txs);
      setResults(res);
      onDone?.(res);
    } catch (e) {
      setError((e as Error).message || "The wallet didn't send the transaction.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {txs.map((t, i) => {
          const r = results?.[i];
          return (
            <li key={i} className="flex items-center gap-2.5 surface-panel px-3 py-2 rounded-card">
              <span
                className={cn(
                  "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
                  !r && "bg-midnight-ink/[0.06]",
                  r?.ok && "bg-deliver-green",
                  r && !r.ok && "bg-destructive text-canvas-white",
                )}
              >
                {r?.ok && <Check className="size-3" strokeWidth={3} />}
                {r && !r.ok && <X className="size-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 text-body-sm text-midnight-ink">
                {txs.length > 1 && <span className="text-muted-ash">Tx {i + 1}: </span>}
                {t.label}
                {r?.error && <span className="block truncate text-caption text-destructive">{r.error}</span>}
              </span>
              {r?.hash && (
                <a href={explorerTxUrl(r.hash)} target="_blank" rel="noreferrer" className="text-muted-ash hover:text-midnight-ink">
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {error && <div className="text-caption text-destructive">{error}</div>}
      <div className="flex items-center gap-3">
        <PillButton disabled={disabled || busy || txs.length === 0} onClick={() => void run()}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? "Waiting for wallet…" : cta}
        </PillButton>
        <button type="button" onClick={() => setViewer(true)} className="inline-flex items-center gap-1 text-caption font-medium text-muted-ash hover:text-midnight-ink">
          <Eye className="size-3.5" /> View details
        </button>
      </div>
      <TxViewerDialog open={viewer} onOpenChange={setViewer} txs={txs} signer={signer} />
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TxFlowViewer } from "@/components/parts/tx-flow-viewer";
import { decodeNearTxs } from "@/lib/near/decode";
import { signedFetch } from "@/lib/api-client";
import type { NearTx } from "@/lib/near/tx";
import type { TxExplainSummary } from "@/lib/tx-view";

/** Readable transaction viewer: every action decoded, graph of the order, optional AI summary. */
export function TxViewerDialog({
  open,
  onOpenChange,
  txs,
  signer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  txs: NearTx[];
  signer?: string;
}) {
  const view = useMemo(() => decodeNearTxs(txs, signer), [txs, signer]);
  const [summary, setSummary] = useState<TxExplainSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [byCmd, setByCmd] = useState<Record<number, string>>({});
  const [explaining, setExplaining] = useState<number | null>(null);

  async function post(body: object) {
    const r = await signedFetch("/api/explain-tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txs, ...body }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto bg-canvas-white sm:max-w-4xl">
        <DialogTitle className="font-alt text-title font-medium text-midnight-ink">
          {txs.length} transaction{txs.length === 1 ? "" : "s"}, {view.steps.length} action
          {view.steps.length === 1 ? "" : "s"}
        </DialogTitle>
        <TxFlowViewer
          view={view}
          aiSummary={summary}
          summarizing={summarizing}
          aiError={aiError}
          onSummarize={async () => {
            setSummarizing(true);
            setAiError(null);
            try {
              setSummary(await post({}));
            } catch (e) {
              setAiError((e as Error).message);
            } finally {
              setSummarizing(false);
            }
          }}
          aiByStep={byCmd}
          explainingStep={explaining}
          onExplainStep={async (i) => {
            setExplaining(i);
            try {
              const j = (await post({ focusCommand: i })) as { explanation: string };
              setByCmd((m) => ({ ...m, [i]: j.explanation }));
            } catch (e) {
              setByCmd((m) => ({ ...m, [i]: `Couldn't explain: ${(e as Error).message}` }));
            } finally {
              setExplaining(null);
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

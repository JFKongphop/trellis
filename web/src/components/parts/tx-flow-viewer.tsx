"use client";

import { useState } from "react";
import { Copy, Check, Sparkles, Loader2, TriangleAlert, ArrowUp, ArrowDown } from "lucide-react";
import { Tag } from "@/components/ui/tag";
import { StatusDisk } from "@/components/ui/status-disk";
import { PillButton } from "@/components/ui/pill-button";
import { TxGraph } from "@/components/parts/tx-graph";
import { stepIcon, stepTitle } from "@/components/parts/tx-step-meta";
import { fmtAddress } from "@/lib/format";
import type { TxExplainSummary, TxStep, TxView } from "@/lib/tx-view";

type Props = {
  view: TxView;
  aiSummary?: TxExplainSummary | null;
  summarizing?: boolean;
  aiError?: string | null;
  onSummarize?: () => void;
  aiByStep?: Record<number, string>;
  explainingStep?: number | null;
  onExplainStep?: (index: number) => void;
};

/** Readable view of a NEAR transaction list: flow of actions + the selected action's details. */
export function TxFlowViewer({ view, aiSummary, summarizing, aiError, onSummarize, aiByStep, explainingStep, onExplainStep }: Props) {
  // Default to the last action: the outcome.
  const [selected, setSelected] = useState<number>(Math.max(0, view.steps.length - 1));
  const safeSelected = Math.min(selected, Math.max(0, view.steps.length - 1));
  const step = view.steps[safeSelected];
  const unknown = view.steps.filter((s) => !s.known).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="shrink-0 space-y-3">
        <AiSummaryBanner summary={aiSummary} summarizing={summarizing} error={aiError} onSummarize={onSummarize} />
        <div className="flex flex-wrap items-center gap-2 text-caption text-muted-ash">
          {view.signer && (
            <span className="inline-flex items-center gap-1">
              Signer
              <span className="font-mono text-midnight-ink">{fmtAddress(view.signer)}</span>
            </span>
          )}
          <Tag tone="neutral">
            {view.txCount} transaction{view.txCount === 1 ? "" : "s"}
          </Tag>
          <Tag tone="neutral">
            {view.steps.length} action{view.steps.length === 1 ? "" : "s"}
          </Tag>
          {unknown > 0 && <Tag tone="gold">{unknown} unknown method{unknown === 1 ? "" : "s"}</Tag>}
          <CopyButton text={view.rawJson} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-4">
        <section className="flex min-h-0 flex-[3] flex-col gap-1.5 lg:flex-1">
          <div className="flex shrink-0 items-center justify-between">
            <SectionLabel>Order of actions</SectionLabel>
            <span className="text-caption text-muted-ash">tap an action to inspect it</span>
          </div>
          {view.steps.length > 0 ? (
            <div className="min-h-0 flex-1">
              <TxGraph view={view} selected={safeSelected} onSelect={setSelected} />
            </div>
          ) : (
            <p className="text-body-sm text-muted-ash">No actions.</p>
          )}
        </section>

        <div className="min-h-0 flex-[2] space-y-3 overflow-y-auto lg:flex-none lg:w-[340px] lg:border-l lg:border-hairline lg:pl-4">
          {step && (
            <StepDetail
              step={step}
              view={view}
              aiPlain={aiByStep?.[step.index]}
              explaining={explainingStep === step.index}
              onExplain={onExplainStep ? () => onExplainStep(step.index) : undefined}
              onSelect={setSelected}
            />
          )}
          <p className="text-caption leading-snug text-muted-ash">
            Actions inside one transaction succeed or fail together; separate transactions don&apos;t. AI explanations are
            best-effort and grounded in the decoded actions.
          </p>
        </div>
      </div>
    </div>
  );
}

function StepDetail({
  step,
  view,
  aiPlain,
  explaining,
  onExplain,
  onSelect,
}: {
  step: TxStep;
  view: TxView;
  aiPlain?: string;
  explaining?: boolean;
  onExplain?: () => void;
  onSelect: (index: number) => void;
}) {
  const args = step.args && Object.keys(step.args).length > 0 ? JSON.stringify(step.args, null, 2) : null;
  return (
    <section className="space-y-3 surface-panel ring-1 ring-hairline px-3.5 py-3 rounded-card">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-6 shrink-0 items-center justify-center bg-whisper-gray text-caption font-medium tabular-nums text-midnight-ink rounded-button">
          {step.index + 1}
        </span>
        <StatusDisk tone="neutral" className="size-7">
          {stepIcon(step)}
        </StatusDisk>
        <span className="min-w-0 flex-1 text-body-sm font-medium text-midnight-ink">{step.label}</span>
      </div>

      {!step.known && (
        <div className="flex items-start gap-1.5 rounded-card bg-warning/15 px-2.5 py-2 text-caption text-midnight-ink">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.4} />
          Trellis doesn&apos;t recognize this method. Check the arguments before signing.
        </div>
      )}

      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1.5 text-body-sm">
        <Row k="Contract">
          <span className="font-mono break-all text-midnight-ink">{step.receiverId}</span>
          {step.receiverLabel && (
            <Tag tone="green" className="ml-1.5">
              {step.receiverLabel}
            </Tag>
          )}
        </Row>
        <Row k={step.kind === "Transfer" ? "Action" : "Method"}>
          <span className="font-mono text-midnight-ink">{stepTitle(step)}</span>
        </Row>
        <Row k="Attached">
          <span className="text-midnight-ink">{step.depositDisplay || "nothing"}</span>
        </Row>
        {step.gasTgas !== undefined && (
          <Row k="Gas">
            <span className="tabular-nums text-midnight-ink">{step.gasTgas} Tgas</span>
          </Row>
        )}
        <Row k="Transaction">
          <span className="text-midnight-ink">
            {step.txIndex + 1} of {view.txCount}
          </span>
        </Row>
      </dl>

      {args && (
        <div className="space-y-1">
          <DetailLabel>Arguments</DetailLabel>
          <pre className="max-h-56 overflow-auto rounded-card bg-whisper-gray px-2.5 py-2 font-mono text-caption leading-relaxed text-midnight-ink">{args}</pre>
        </div>
      )}

      {(step.after !== null || step.before !== null) && (
        <div className="flex flex-wrap gap-1.5">
          {step.after !== null && <NavChip dir="up" step={view.steps[step.after]!} onSelect={onSelect} />}
          {step.before !== null && <NavChip dir="down" step={view.steps[step.before]!} onSelect={onSelect} />}
        </div>
      )}

      <div className="border-t border-hairline/60 pt-2.5">
        {aiPlain ? (
          <div className="space-y-1">
            <DetailLabel>
              <span className="inline-flex items-center gap-1">
                <Sparkles className="size-3 text-midnight-violet" strokeWidth={2.4} />
                AI explanation
              </span>
            </DetailLabel>
            <p className="text-body-sm leading-relaxed text-midnight-ink">{aiPlain}</p>
          </div>
        ) : onExplain ? (
          <PillButton variant="ghost" onClick={onExplain} disabled={explaining} className="px-0 py-0 text-caption">
            {explaining ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={2.4} />
            ) : (
              <Sparkles className="size-3.5 text-midnight-violet" strokeWidth={2.4} />
            )}
            {explaining ? "Reading…" : "Explain this step with Trellis"}
          </PillButton>
        ) : null}
      </div>
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-caption text-muted-ash">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function NavChip({ dir, step, onSelect }: { dir: "up" | "down"; step: TxStep; onSelect: (i: number) => void }) {
  const Icon = dir === "up" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSelect(step.index)}
      className="inline-flex cursor-pointer items-center gap-1 rounded-button bg-deliver-green/15 px-2 py-0.5 text-caption text-midnight-ink transition-colors hover:bg-deliver-green/25"
    >
      <Icon className="size-3 text-deliver-green" strokeWidth={2.4} />
      <span className="font-mono">#{step.index + 1}</span>
      <span className="max-w-[12rem] truncate text-muted-ash">{stepTitle(step)}</span>
    </button>
  );
}

function AiSummaryBanner({
  summary,
  summarizing,
  error,
  onSummarize,
}: {
  summary?: TxExplainSummary | null;
  summarizing?: boolean;
  error?: string | null;
  onSummarize?: () => void;
}) {
  return (
    <div className="surface-panel ring-1 ring-hairline px-3.5 py-3 rounded-card">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-caption font-medium uppercase tracking-wider text-muted-ash">
          <Sparkles className="size-3 text-midnight-violet" strokeWidth={2.4} />
          Plain English
          <Tag tone="violet">AI</Tag>
        </span>
        {!summary && onSummarize && (
          <PillButton variant="secondary" onClick={onSummarize} disabled={summarizing} className="px-3 py-1.5 text-caption">
            {summarizing && <Loader2 className="size-3.5 animate-spin" strokeWidth={2.4} />}
            {summarizing ? "Reading…" : "Summarize with Trellis"}
          </PillButton>
        )}
      </div>
      {summary?.summary && <p className="mt-2 text-body-sm leading-relaxed text-midnight-ink">{summary.summary}</p>}
      {!summary && !summarizing && (
        <p className="mt-1.5 text-caption leading-snug text-muted-ash">
          Trellis can read these transactions and explain them in plain English, only when you ask.
        </p>
      )}
      {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-ash">{children}</p>;
}

const DetailLabel = SectionLabel;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="ml-auto inline-flex cursor-pointer items-center gap-1 bg-whisper-gray px-2 py-1 text-caption font-medium text-midnight-ink transition-colors hover:bg-light-taupe rounded-button"
    >
      {copied ? <Check className="size-3" strokeWidth={2.6} /> : <Copy className="size-3" strokeWidth={2.4} />}
      {copied ? "Copied" : "Copy raw JSON"}
    </button>
  );
}

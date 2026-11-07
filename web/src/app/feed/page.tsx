"use client";

// Public feed of agent moves across every vault the worker protects (frontend-spec §2).
// Each row is an on-chain vault receipt; ⚡ marks moves the agent made on its own to protect a position.

import { useMemo, useState } from "react";
import { ArrowLeftRight, Coins, ExternalLink, Globe, Landmark, Zap } from "lucide-react";
import { CinematicShell } from "@/components/parts/cinematic-shell";
import { ToolCallRow } from "@/components/parts/tool-call-row";
import { StatusDisk } from "@/components/ui/status-disk";
import { Tag } from "@/components/ui/tag";
import { useFeed } from "@/lib/near/client";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/near/config";
import { hfFromBps } from "@/lib/near/vault";
import { receiptAgo, receiptText } from "@/lib/near/receipt-text";
import { useNow } from "@/lib/use-now";
import type { FeedItem } from "@/lib/feed";
import { cn } from "@/lib/utils";

type Filter = "all" | "auto" | "plan" | "failed";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "auto", label: "⚡ Automatic" },
  { id: "plan", label: "Owner-approved" },
  { id: "failed", label: "Failed" },
];

export default function FeedPage() {
  const feed = useFeed();
  const [filter, setFilter] = useState<Filter>("all");
  const items = useMemo(() => {
    const all = feed.data?.items ?? [];
    if (filter === "auto") return all.filter((r) => r.origin === "auto");
    if (filter === "plan") return all.filter((r) => r.origin === "plan");
    if (filter === "failed") return all.filter((r) => r.status === "Failed");
    return all;
  }, [feed.data, filter]);

  return (
    <CinematicShell mode="dim">
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 px-4 pt-24 pb-10 sm:px-6">
        <div className="space-y-1">
          <h1 className="font-alt text-title font-medium tracking-tight text-midnight-ink">Agent feed</h1>
          <p className="text-body-sm text-muted-ash">
            Every move Trellis agents made, read live from each vault on NEAR. Each one passed the vault&apos;s on-chain rules.{" "}
            <span className="text-brand-orange">⚡</span> marks automatic protection.
          </p>
        </div>

        {feed.isPending ? (
          <ToolCallRow label="Reading vault receipts…" status="input-available" />
        ) : feed.isError ? (
          <ToolCallRow label={feed.error.message} status="output-error" />
        ) : !feed.data.configured ? (
          <div className="surface-card p-5 text-body-sm text-muted-ash rounded-card">
            The feed lists the vaults the Trellis worker protects. This server has no worker configured (WORKER_URL).
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Moves, last 24 h" value={feed.data.stats.moves} />
              <Stat label="Automatic" value={feed.data.stats.automatic} accent />
              <Stat label="Vaults active" value={`${feed.data.stats.vaultsActive} / ${feed.data.vaults}`} />
              <Stat label="Failed (safely)" value={feed.data.stats.failed} />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "rounded-button px-3 py-1.5 text-caption font-medium ring-1 transition-colors",
                    filter === f.id
                      ? "bg-midnight-ink text-canvas-white ring-midnight-ink"
                      : "surface-card text-midnight-ink ring-hairline hover:ring-midnight-ink/30",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {items.length === 0 ? (
              <div className="surface-card p-5 text-body-sm text-muted-ash rounded-card">
                {filter === "all" ? "No agent moves yet." : "Nothing here for this filter."}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {items.map((r) => (
                  <Row key={`${r.vault_id}:${r.op_id}`} r={r} />
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </CinematicShell>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className="surface-card px-4 py-3 rounded-card">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-ash">{label}</div>
      <div className={cn("text-display-sm font-medium tabular-nums", accent ? "text-brand-orange" : "text-midnight-ink")}>{value}</div>
    </div>
  );
}

function kindIcon(kind: FeedItem["kind"]) {
  const cls = "size-4";
  switch (kind) {
    case "SwapRef":
    case "RecoverRef":
      return <ArrowLeftRight className={cls} strokeWidth={2.4} />;
    case "IntentsRoute":
    case "IntentsWithdraw":
      return <Globe className={cls} strokeWidth={2.4} />;
    case "WrapNear":
      return <Coins className={cls} strokeWidth={2.4} />;
    default:
      return <Landmark className={cls} strokeWidth={2.4} />;
  }
}

const fmtHf = (bps: string | null | undefined) => {
  const v = bps ? hfFromBps(bps) : null;
  return v === null ? "∞" : v.toFixed(2);
};

function Row({ r }: { r: FeedItem }) {
  const now = useNow();
  const failed = r.status === "Failed";
  const hfAfter = r.health_factor_bps ? fmtHf(r.health_factor_bps) : null;
  const hfBefore = r.hf_before_bps ? fmtHf(r.hf_before_bps) : null;
  const detail = failed ? `Stopped: ${r.note || "failed"}` : r.origin === "auto" && r.why ? r.why : r.note;
  return (
    <li className="flex items-start gap-3 surface-card px-3.5 py-3 rounded-card">
      <StatusDisk tone={failed ? "red" : r.origin === "auto" ? "gold" : "neutral"} className="mt-0.5 size-8">
        {kindIcon(r.kind)}
      </StatusDisk>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex flex-wrap items-center gap-1.5 text-body-sm text-midnight-ink">
          <span>{receiptText(r)}</span>
          {r.origin === "auto" && (
            <span className="inline-flex items-center gap-0.5 rounded-card bg-brand-orange/15 px-1.5 text-[10px] font-medium uppercase tracking-wider text-brand-orange">
              <Zap className="size-2.5" strokeWidth={2.6} /> Auto
            </span>
          )}
          {r.origin === "plan" && <Tag>Owner-approved</Tag>}
          {failed && <Tag tone="red">Failed</Tag>}
        </div>
        {detail && <div className="mt-0.5 text-caption text-muted-ash">{detail}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-ash">
          <a href={explorerAccountUrl(r.vault_id)} target="_blank" rel="noreferrer" className="font-mono hover:text-midnight-ink">
            {shortVault(r.vault_id)}
          </a>
          {hfAfter ? (
            <span className="tabular-nums">
              HF {hfBefore ? `${hfBefore} → ` : ""}
              <span className="text-midnight-ink">{hfAfter}</span>
            </span>
          ) : hfBefore ? (
            // swaps / repays don't record HF after; show what the agent saw before acting
            <span className="tabular-nums">HF {hfBefore} before</span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-caption text-muted-ash">
        <span>{receiptAgo(r, now)}</span>
        {r.tx_hash && (
          <a href={explorerTxUrl(r.tx_hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-midnight-ink">
            tx <ExternalLink className="size-3" />
          </a>
        )}
      </div>
    </li>
  );
}

/** "v1a2b3c4d5e6f7a8b.trellis.near" → "v1a2b…a8b.trellis.near" */
function shortVault(id: string) {
  const [name, ...rest] = id.split(".");
  const short = name && name.length > 10 ? `${name.slice(0, 5)}…${name.slice(-3)}` : name;
  return [short, ...rest].join(".");
}

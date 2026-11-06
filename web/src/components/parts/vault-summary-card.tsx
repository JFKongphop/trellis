"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Bot, ArrowRight } from "lucide-react";
import { StatusDisk } from "@/components/ui/status-disk";
import { Tag } from "@/components/ui/tag";
import { fmtUsd } from "@/lib/format";
import { hfLabel, hfTone } from "@/components/parts/lending-position-card";

export type VaultSummary = {
  exists: boolean;
  vaultId?: string;
  paused?: boolean;
  agent?: string | null;
  healthFactor?: number | null;
  netValueUsd?: number;
  walletUsd?: number;
  receipts?: { what: string; status: string; when: string }[];
};

/** Compact vault snapshot (getVault). The full dashboard is /vault. */
export function VaultSummaryCard({ v }: { v: VaultSummary }) {
  if (!v.exists) {
    return (
      <div className="surface-card max-w-[460px] space-y-2 px-5 py-4 rounded-card">
        <div className="text-body-sm text-midnight-ink">No Trellis vault for this account yet.</div>
        <Link href="/vault/setup" className="inline-flex items-center gap-1 text-body-sm font-medium text-midnight-ink underline underline-offset-2">
          Set one up <ArrowRight className="size-3.5" />
        </Link>
      </div>
    );
  }
  const tone = hfTone(v.healthFactor ?? null);
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="surface-card max-w-[480px] space-y-2 p-3 rounded-card">
      <div className="flex items-center gap-2.5 px-1">
        <StatusDisk tone="green" className="size-8">
          <Bot className="size-4" strokeWidth={2.4} />
        </StatusDisk>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-caption font-medium uppercase tracking-wider text-muted-ash">{v.vaultId}</div>
          <div className="text-body-sm font-medium text-midnight-ink">
            HF {v.healthFactor == null ? "∞" : v.healthFactor.toFixed(2)} · {fmtUsd((v.netValueUsd ?? 0) + (v.walletUsd ?? 0))}
          </div>
        </div>
        <Tag tone={v.paused ? "gold" : v.agent ? "green" : "neutral"}>{v.paused ? "paused" : v.agent ? "agent on" : "no agent"}</Tag>
        <Tag tone={tone === "neutral" ? "neutral" : tone}>{hfLabel(v.healthFactor ?? null)}</Tag>
      </div>
      {v.receipts && v.receipts.length > 0 && (
        <ul className="space-y-1">
          {v.receipts.slice(0, 5).map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-2 surface-panel px-3 py-1.5 text-caption rounded-card">
              <span className="truncate text-midnight-ink">{r.what}</span>
              <span className="shrink-0 text-muted-ash">{r.status} · {r.when}</span>
            </li>
          ))}
        </ul>
      )}
      <Link href="/vault" className="inline-flex items-center gap-1 px-1 text-caption font-medium text-muted-ash hover:text-midnight-ink">
        Open dashboard <ArrowRight className="size-3" />
      </Link>
    </motion.div>
  );
}

"use client";

import { ORACLE } from "@/lib/near/config";
import { motion } from "motion/react";
import { ShieldAlert, ShieldCheck, Shield } from "lucide-react";
import { AssetIcon } from "@/components/asset-icon";
import { StatusDisk } from "@/components/ui/status-disk";
import { Tag } from "@/components/ui/tag";
import { shortAccount } from "@/lib/avatar";
import { fmtAmount, fmtPct, fmtPriceUsd, fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LendingPosition, PositionLine } from "@/lib/near/client";

type IconLookup = (tokenId: string) => string | undefined;

/** Health-factor bands used across Trellis (rhea-burrow-lending strategies §6). */
export function hfTone(hf: number | null): "green" | "gold" | "red" | "neutral" {
  if (hf === null) return "neutral";
  if (hf >= 1.5) return "green";
  if (hf >= 1.2) return "gold";
  return "red";
}

export function hfLabel(hf: number | null): string {
  if (hf === null) return "No debt";
  if (hf < 1) return "Liquidatable";
  if (hf < 1.2) return "At risk";
  if (hf < 1.5) return "Thin buffer";
  return "Healthy";
}

/** Rhea Lending position + health factor. Shown after getLendingPosition. */
export function LendingPositionCard({
  position,
  iconLookup,
  fill,
}: {
  position: LendingPosition;
  iconLookup?: IconLookup;
  /** Fill the parent's width (dashboard grids) instead of the chat-bubble max width. */
  fill?: boolean;
}) {
  const p = position;
  const empty =
    p.collateral.length === 0 && p.borrowed.length === 0 && p.supplied.length === 0;

  if (!p.registered || empty) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className={cn("surface-card px-5 py-4 rounded-card", fill ? "w-full" : "max-w-[460px]")}
      >
        <div className="text-caption font-medium uppercase tracking-wider text-muted-ash">
          Rhea Lending · {shortAccount(p.accountId)}
        </div>
        <div className="mt-1 text-body-sm text-midnight-ink">
          {p.registered
            ? "No open position. Nothing supplied, nothing borrowed."
            : "This account hasn't used Rhea Lending yet."}
        </div>
      </motion.div>
    );
  }

  const tone = hfTone(p.healthFactor);
  const Icon = tone === "red" ? ShieldAlert : tone === "green" ? ShieldCheck : Shield;
  const liq = p.liquidationPrices[0];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", visualDuration: 0.35, bounce: 0.18 }}
      className={cn("surface-card p-2 rounded-card", fill ? "w-full" : "max-w-[480px]")}
    >
      {/* Header: health factor */}
      <div className="flex items-center gap-3 px-3 pt-3 pb-3">
        <StatusDisk tone={tone === "neutral" ? "neutral" : tone} solid={tone === "red"}>
          <Icon className="size-4" strokeWidth={2.4} />
        </StatusDisk>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-caption font-medium uppercase tracking-wider text-muted-ash">
            Rhea Lending · {shortAccount(p.accountId)}
          </span>
          <span className="flex items-baseline gap-2">
            <span className="text-display-sm font-medium tabular-nums text-midnight-ink">
              {p.healthFactor === null
                ? "∞"
                : p.healthFactor >= 100
                  ? "100+"
                  : p.healthFactor.toFixed(2)}
            </span>
            <span className="text-body-sm text-muted-ash">health factor</span>
          </span>
        </div>
        <Tag tone={tone === "neutral" ? "neutral" : tone}>{hfLabel(p.healthFactor)}</Tag>
      </div>

      {/* Key stats */}
      <div className="grid grid-cols-3 gap-1 px-1 pb-2">
        <Stat label="Net value" value={p.netValueUsd !== undefined ? fmtUsd(p.netValueUsd) : "—"} />
        <Stat
          label="Debt / collateral"
          value={p.loanToValuePct !== undefined ? fmtPct(p.loanToValuePct) : "—"}
        />
        <Stat
          label={liq ? `${liq.symbol} liq. price` : "Liq. price"}
          value={liq ? fmtPriceUsd(liq.liquidationPriceUsd) : "—"}
          sub={liq ? `${liq.dropPct.toFixed(0)}% below ${fmtPriceUsd(liq.currentPriceUsd)}` : undefined}
        />
      </div>

      {p.collateral.length > 0 && (
        <Section title="Collateral">
          {p.collateral.map((l) => (
            <Line key={`c-${l.tokenId}`} l={l} kind="collateral" iconLookup={iconLookup} />
          ))}
        </Section>
      )}
      {p.borrowed.length > 0 && (
        <Section title="Borrowed">
          {p.borrowed.map((l) => (
            <Line key={`b-${l.tokenId}`} l={l} kind="borrowed" iconLookup={iconLookup} />
          ))}
        </Section>
      )}
      {p.supplied.length > 0 && (
        <Section title="Supplied (not collateral)">
          {p.supplied.map((l) => (
            <Line key={`s-${l.tokenId}`} l={l} kind="supplied" iconLookup={iconLookup} />
          ))}
        </Section>
      )}

      {p.notes.length > 0 && (
        <ul className="space-y-0.5 px-3 pt-2 pb-2 text-caption text-muted-ash">
          {p.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className="px-3 pt-1 pb-2 text-[10px] uppercase tracking-wider text-muted-ash">
        Prices: {ORACLE}{p.pricesFresh ? "" : " (some stale)"}
      </div>
    </motion.div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="surface-panel px-3 py-2 rounded-card">
      <div className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-ash">
        {label}
      </div>
      <div className="text-body-sm font-medium tabular-nums text-midnight-ink">{value}</div>
      {sub && <div className="truncate text-[11px] text-muted-ash">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pb-1">
      <div className="px-3 pt-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-ash">
        {title}
      </div>
      <ul className="flex flex-col gap-1">{children}</ul>
    </div>
  );
}

function Line({
  l,
  kind,
  iconLookup,
}: {
  l: PositionLine;
  kind: "collateral" | "borrowed" | "supplied";
  iconLookup?: IconLookup;
}) {
  return (
    <li className="flex items-center gap-3 surface-panel px-3 py-2.5 rounded-card">
      <AssetIcon src={iconLookup?.(l.tokenId)} label={l.symbol} size={28} />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-body-sm font-medium text-midnight-ink">{l.symbol}</span>
        <span className="truncate text-caption text-muted-ash">
          {kind === "borrowed" ? "costs" : "earns"} {fmtPct(l.aprPct)} APR
          {l.collateralFactorPct !== undefined && kind === "collateral"
            ? ` · counts ${l.collateralFactorPct}%`
            : ""}
        </span>
      </div>
      <div className="flex flex-col items-end leading-tight">
        <span
          className={cn(
            "text-body-sm font-medium tabular-nums text-midnight-ink",
          )}
        >
          {l.valueUsd !== undefined ? fmtUsd(l.valueUsd) : fmtAmount(l.amount)}
        </span>
        <span className="text-caption tabular-nums text-muted-ash">
          {fmtAmount(l.amount)} {l.symbol}
        </span>
      </div>
    </li>
  );
}

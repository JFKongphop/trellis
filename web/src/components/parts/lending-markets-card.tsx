"use client";

import { motion } from "motion/react";
import { AssetIcon } from "@/components/asset-icon";
import { Tag } from "@/components/ui/tag";
import { fmtPct, fmtUsdShort, fmtCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LendingMarket } from "@/lib/near/client";

type IconLookup = (tokenId: string) => string | undefined;

/** Rhea Lending markets. Shown after getLendingMarkets. */
export function LendingMarketsCard({
  markets,
  iconLookup,
}: {
  markets: LendingMarket[];
  iconLookup?: IconLookup;
}) {
  if (markets.length === 0) {
    return (
      <div className="surface-card px-5 py-4 text-body-sm text-muted-ash rounded-card">
        No matching Rhea Lending market.
      </div>
    );
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", visualDuration: 0.35, bounce: 0.18 }}
      className="surface-card max-w-[560px] p-2 rounded-card"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-caption font-medium uppercase tracking-wider text-muted-ash">
          Rhea Lending markets · {markets.length}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-ash">
          variable rates
        </span>
      </div>
      <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
        {markets.map((m, i) => (
          <motion.li
            key={m.tokenId}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.03 * i, duration: 0.2 }}
            className="surface-panel px-3 py-2.5 rounded-card"
          >
            <div className="flex items-center gap-3">
              <AssetIcon src={iconLookup?.(m.tokenId)} label={m.symbol} size={28} />
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="flex items-center gap-1.5 truncate text-body-sm font-medium text-midnight-ink">
                  {m.symbol}
                  {!m.verified && <Tag tone="gold">unverified</Tag>}
                  {m.canUseAsCollateral && <Tag>collateral {m.collateralFactorPct}%</Tag>}
                </span>
                <span className="truncate text-caption text-muted-ash">
                  {m.totalSuppliedUsd !== undefined
                    ? `${fmtUsdShort(m.totalSuppliedUsd)} supplied`
                    : `${fmtCompact(m.totalSupplied)} supplied`}
                  {" · "}
                  {m.availableLiquidityUsd !== undefined
                    ? `${fmtUsdShort(m.availableLiquidityUsd)} free`
                    : `${fmtCompact(m.availableLiquidity)} free`}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-right leading-tight">
                <div>
                  <div className="text-body-sm font-medium tabular-nums text-midnight-ink">
                    {fmtPct(m.supplyAprPct)}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-ash">supply</div>
                </div>
                <div>
                  <div className="text-body-sm font-medium tabular-nums text-midnight-ink">
                    {m.canBorrow ? fmtPct(m.borrowAprPct) : "—"}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-ash">borrow</div>
                </div>
              </div>
            </div>
            {m.canBorrow && (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-midnight-ink/[0.06]">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      m.utilizationPct >= 90
                        ? "bg-destructive"
                        : m.utilizationPct >= 75
                          ? "bg-warning"
                          : "bg-deliver-green",
                    )}
                    // runtime-dynamic width (allowed inline-style carve-out)
                    style={{ width: `${Math.min(100, Math.max(0, m.utilizationPct))}%` }}
                  />
                </div>
                <span className="w-24 text-right text-[11px] tabular-nums text-muted-ash">
                  {m.utilizationPct.toFixed(1)}% used
                </span>
              </div>
            )}
          </motion.li>
        ))}
      </ul>
    </motion.div>
  );
}

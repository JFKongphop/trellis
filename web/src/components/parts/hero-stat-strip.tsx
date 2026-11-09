"use client";

import { Fragment } from "react";
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { Landmark, TrendingUp } from "lucide-react";
import { useLendingMarkets } from "@/lib/near/client";
import { TOKENS, WRAP_NEAR } from "@/lib/near/config";
import { fmtPriceUsd, fmtUsdShort } from "@/lib/format";

type Item = {
  /** Short value token. null = still loading → shimmer. */
  value: string | null;
  label: string;
  /** The genuinely-live metric — gets a pulsing "live" dot instead of an icon. */
  live?: boolean;
  Icon?: LucideIcon;
};

/**
 * Live proof bar under the hero input. Every value is read live from Rhea
 * Lending (`/api/markets`): NEAR price, the USDC supply and borrow APRs, and
 * total value supplied across Rhea markets. Values shimmer until loaded and
 * the strip quietly hides if the read fails.
 */
export function HeroStatStrip() {
  const { data: markets, isError } = useLendingMarkets();
  if (isError) return null;

  const usdc = markets?.find((m) => m.tokenId === TOKENS.USDC);
  const near = markets?.find((m) => m.tokenId === WRAP_NEAR);
  const tvl = markets
    ? markets.reduce((s, m) => s + (m.totalSuppliedUsd ?? 0), 0)
    : null;

  // A near-empty market (testnet) has ~0% rates: "0.0%" reads as broken, so those two are left out.
  const ratesShown = !usdc || usdc.borrowAprPct >= 0.05;
  const items: Item[] = [
    {
      value: near?.priceUsd != null ? fmtPriceUsd(near.priceUsd) : null,
      label: "NEAR",
      live: true,
    },
    ...(ratesShown
      ? [
          {
            value: usdc ? `${usdc.supplyAprPct.toFixed(1)}%` : null,
            label: "USDC supply APR",
            Icon: TrendingUp,
          },
          {
            value: usdc ? `${usdc.borrowAprPct.toFixed(1)}%` : null,
            label: "USDC borrow APR",
            Icon: TrendingUp,
          },
        ]
      : []),
    {
      value: tvl != null ? fmtUsdShort(tvl) : null,
      label: "on Rhea Lending",
      Icon: Landmark,
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", visualDuration: 0.6, bounce: 0.1, delay: 0.55 }}
      className="mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1.5 rounded-card border border-hairline bg-canvas-white/70 px-4 py-2 text-caption shadow-button backdrop-blur-sm"
    >
      {items.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && (
            <span
              aria-hidden
              className="hidden h-3 w-px shrink-0 self-center bg-midnight-ink/10 sm:block"
            />
          )}
          <span className="inline-flex items-center gap-1.5">
            {s.live ? (
              <span
                className="size-1.5 shrink-0 self-center rounded-full bg-deliver-green motion-safe:animate-pulse"
                aria-hidden
              />
            ) : s.Icon ? (
              <s.Icon
                className="size-3.5 shrink-0 self-center text-muted-ash"
                strokeWidth={2.2}
                aria-hidden
              />
            ) : null}
            {s.value === null ? (
              <span
                className="inline-block h-3 w-10 self-center rounded bg-midnight-ink/10 motion-safe:animate-pulse"
                aria-hidden
              />
            ) : (
              <span className="font-medium tabular-nums text-midnight-ink">
                {s.value}
              </span>
            )}
            <span className="text-muted-ash">{s.label}</span>
          </span>
        </Fragment>
      ))}
    </motion.div>
  );
}

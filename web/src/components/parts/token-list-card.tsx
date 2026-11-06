"use client";

import { motion } from "motion/react";
import { AssetIcon } from "@/components/asset-icon";
import { Tag } from "@/components/ui/tag";
import { shortAccount } from "@/lib/avatar";
import { fmtPriceUsd } from "@/lib/format";

export type TokenListRow = {
  tokenId: string;
  symbol: string;
  name?: string;
  priceUsd?: number;
  verified: boolean;
};

type IconLookup = (tokenId: string) => string | undefined;

/** Token prices / search results. Shown after getTokenPrice and searchToken. */
export function TokenListCard({
  title,
  rows,
  iconLookup,
}: {
  title: string;
  rows: TokenListRow[];
  iconLookup?: IconLookup;
}) {
  if (rows.length === 0) {
    return (
      <div className="surface-card px-5 py-4 text-body-sm text-muted-ash rounded-card">
        No matching token.
      </div>
    );
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", visualDuration: 0.35, bounce: 0.18 }}
      className="surface-card max-w-[440px] p-2 rounded-card"
    >
      <div className="px-3 pt-3 pb-2 text-caption font-medium uppercase tracking-wider text-muted-ash">
        {title}
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li
            key={r.tokenId}
            className="flex items-center gap-3 surface-panel px-3 py-2.5 rounded-card"
          >
            <AssetIcon src={iconLookup?.(r.tokenId)} label={r.symbol} size={28} />
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="flex items-center gap-1.5 truncate text-body-sm font-medium text-midnight-ink">
                {r.symbol}
                {r.verified ? <Tag tone="green">verified</Tag> : <Tag tone="gold">unverified</Tag>}
              </span>
              <span className="truncate text-caption text-muted-ash" title={r.tokenId}>
                {r.name ? `${r.name} · ` : ""}
                {shortAccount(r.tokenId)}
              </span>
            </div>
            <span className="text-body-sm font-medium tabular-nums text-midnight-ink">
              {r.priceUsd !== undefined ? fmtPriceUsd(r.priceUsd) : "no price"}
            </span>
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

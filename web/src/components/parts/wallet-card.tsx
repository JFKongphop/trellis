"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { AssetIcon } from "@/components/asset-icon";
import { Tag } from "@/components/ui/tag";
import { shortAccount } from "@/lib/avatar";
import { fmtAmount, fmtUsd, fmtPriceUsd } from "@/lib/format";

export type WalletBalance = {
  tokenId: string;
  symbol: string;
  balance: number;
  /** Per-unit USD price (display-only, from Ref's indexer). */
  priceUsd?: number;
  /** balance × priceUsd (skipped when no price is available). */
  valueUsd?: number;
  /** Ref-whitelisted or well-known. Unverified tokens may be spam airdrops. */
  verified: boolean;
};

type IconLookup = (tokenId: string) => string | undefined;

type Props = {
  balances: WalletBalance[];
  accountId?: string;
  iconLookup?: IconLookup;
  /** Fill the parent's width (dashboard grids) instead of the chat-bubble max width. */
  fill?: boolean;
};

/** Every non-zero balance of a NEAR account. Shown after getBalances resolves. */
export function WalletCard({ balances, accountId, iconLookup, fill }: Props) {
  const verified = balances.filter((b) => b.verified);
  const unverified = balances.filter((b) => !b.verified);
  const totalUsd = verified.reduce(
    (s, b) => s + (Number.isFinite(b.valueUsd) ? (b.valueUsd ?? 0) : 0),
    0,
  );
  const hasAnyValue = verified.some(
    (b) => typeof b.valueUsd === "number" && Number.isFinite(b.valueUsd),
  );

  if (balances.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="surface-card px-5 py-4 text-body-sm text-muted-ash rounded-card"
      >
        No balances found for this account.
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", visualDuration: 0.35, bounce: 0.18 }}
      className={cn("surface-card p-2 rounded-card", fill ? "w-full" : "max-w-[460px]")}
    >
      <div className="flex items-end justify-between gap-3 px-3 pt-3 pb-3">
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-caption font-medium uppercase tracking-wider text-muted-ash">
            {accountId ? shortAccount(accountId) : "Wallet"} · {verified.length} token
            {verified.length === 1 ? "" : "s"}
          </span>
          {hasAnyValue && (
            <span className="text-display-sm font-medium tabular-nums text-midnight-ink">
              {fmtUsd(totalUsd)}
            </span>
          )}
        </div>
      </div>

      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {verified.map((b, i) => (
          <TokenRow key={b.tokenId} b={b} i={i} iconLookup={iconLookup} />
        ))}
      </ul>

      {unverified.length > 0 && (
        <>
          <div className="px-3 pt-3 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-ash">
            Unverified · may be spam airdrops
          </div>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {unverified.map((b, i) => (
              <TokenRow key={b.tokenId} b={b} i={i} iconLookup={iconLookup} />
            ))}
          </ul>
        </>
      )}
    </motion.div>
  );
}

function TokenRow({
  b,
  i,
  iconLookup,
}: {
  b: WalletBalance;
  i: number;
  iconLookup?: IconLookup;
}) {
  const hasValue = typeof b.valueUsd === "number" && Number.isFinite(b.valueUsd);
  const hasPrice =
    typeof b.priceUsd === "number" && Number.isFinite(b.priceUsd) && b.priceUsd > 0;
  return (
    <motion.li
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.04 * i, duration: 0.2 }}
      className="flex items-center gap-3 surface-panel px-3 py-2.5 rounded-card"
    >
      <AssetIcon src={iconLookup?.(b.tokenId)} label={b.symbol} size={32} />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="flex items-center gap-1.5 truncate text-body-sm font-medium text-midnight-ink">
          {b.symbol}
          {!b.verified && <Tag tone="gold">unverified</Tag>}
        </span>
        <span className="truncate text-caption text-muted-ash" title={b.tokenId}>
          {hasPrice ? fmtPriceUsd(b.priceUsd!) : b.tokenId === "near" ? "native" : shortAccount(b.tokenId)}
        </span>
      </div>
      <div className="flex flex-col items-end leading-tight">
        <span className="text-body-sm font-medium tabular-nums text-midnight-ink">
          {hasValue && b.verified ? fmtUsd(b.valueUsd!) : fmtAmount(b.balance)}
        </span>
        <span className="text-caption tabular-nums text-muted-ash">
          {fmtAmount(b.balance)} {b.symbol}
        </span>
      </div>
    </motion.li>
  );
}

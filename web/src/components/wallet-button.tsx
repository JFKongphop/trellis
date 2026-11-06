"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ChevronDown,
  Copy,
  Check,
  ExternalLink,
  LogOut,
  Wallet as WalletIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PillButton } from "@/components/ui/pill-button";
import { Identicon } from "@/components/ui/identicon";
import { shortAccount } from "@/lib/avatar";
import { fmtAmount } from "@/lib/format";
import { explorerAccountUrl } from "@/lib/near/config";
import { useNearAccount, useNearBalance } from "@/lib/near/use-near-account";

/**
 * Header wallet control. Disconnected: opens the NEAR Connect wallet picker
 * (HOT, Meteor, Intear, MyNearWallet, Ledger, …). Connected: account id + NEAR
 * balance, with a menu to copy the id, open NearBlocks, or disconnect.
 */
export function WalletButton({
  tone = "default",
  className,
}: { tone?: "default" | "glass"; className?: string } = {}) {
  const { accountId, loading, signIn, signOut } = useNearAccount();
  const balance = useNearBalance(accountId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  if (!accountId) {
    const glass = tone === "glass";
    return (
      <PillButton
        variant={glass ? "secondary" : "primary"}
        disabled={loading || connecting}
        onClick={async () => {
          setConnecting(true);
          try {
            await signIn();
          } catch {
            // Picker closed ("User rejected") — nothing to do.
          } finally {
            setConnecting(false);
          }
        }}
        className={cn(
          glass
            ? "gap-1.5 bg-canvas-white shadow-button hover:bg-whisper-gray"
            : "gap-2 px-5 py-2.5",
          className,
        )}
      >
        <WalletIcon className={glass ? "size-3.5" : "size-4"} strokeWidth={2.4} />
        {connecting ? "Connecting…" : glass ? "Connect" : "Connect wallet"}
      </PillButton>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <motion.button
        onClick={() => setMenuOpen((v) => !v)}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        transition={{ type: "spring", visualDuration: 0.2, bounce: 0.3 }}
        className="inline-flex h-9 items-center gap-2 bg-canvas-white py-1 pl-1.5 pr-3 text-body-sm font-medium text-midnight-ink ring-1 ring-hairline shadow-button rounded-button"
      >
        <Identicon address={accountId} size={24} />
        <span className="max-w-[140px] truncate">{shortAccount(accountId)}</span>
        {balance.data !== undefined && (
          <span className="hidden tabular-nums text-muted-ash sm:inline">
            {fmtAmount(balance.data)} NEAR
          </span>
        )}
        <motion.span
          animate={{ rotate: menuOpen ? 180 : 0 }}
          transition={{ type: "spring", visualDuration: 0.2, bounce: 0.3 }}
          className="inline-flex"
        >
          <ChevronDown className="size-3.5" strokeWidth={2.4} />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {menuOpen && (
          <WalletMenu
            accountId={accountId}
            balanceNear={balance.data}
            onDisconnect={() => {
              void signOut();
              setMenuOpen(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function WalletMenu({
  accountId,
  balanceNear,
  onDisconnect,
}: {
  accountId: string;
  balanceNear?: number;
  onDisconnect: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyAccount() {
    void navigator.clipboard.writeText(accountId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.97 }}
      transition={{ type: "spring", visualDuration: 0.25, bounce: 0.2 }}
      className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 origin-top-right rounded-card bg-canvas-white p-1.5 ring-1 ring-hairline shadow-header"
    >
      <div className="flex items-center gap-2.5 bg-whisper-gray px-2.5 py-2.5 rounded-card">
        <Identicon address={accountId} size={32} className="shrink-0" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="break-all text-body-sm font-medium leading-tight">
            {accountId}
          </div>
          <div className="text-caption tabular-nums text-muted-ash">
            {balanceNear !== undefined
              ? `${fmtAmount(balanceNear)} NEAR`
              : "Reading balance…"}
          </div>
        </div>
      </div>
      <div className="mt-1 space-y-0.5">
        <MenuItem
          Icon={copied ? Check : Copy}
          label={copied ? "Copied!" : "Copy account id"}
          onClick={copyAccount}
        />
        <MenuItem
          Icon={ExternalLink}
          label="View on NearBlocks"
          href={explorerAccountUrl(accountId)}
        />
        <div className="my-1 h-px bg-hairline" />
        <MenuItem Icon={LogOut} label="Disconnect" onClick={onDisconnect} danger />
      </div>
    </motion.div>
  );
}

function MenuItem({
  Icon,
  label,
  onClick,
  href,
  danger,
}: {
  Icon: typeof Copy;
  label: string;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
}) {
  const cls = cn(
    "flex w-full items-center gap-2 rounded-button px-2.5 py-1.5 text-left text-body-sm font-medium transition-colors",
    danger
      ? "text-destructive hover:bg-destructive/10"
      : "text-midnight-ink hover:bg-whisper-gray",
  );
  const inner = (
    <>
      <Icon className="size-3.5" strokeWidth={2.2} />
      {label}
    </>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

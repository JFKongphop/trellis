"use client";

// Fund a NEAR account (your vault or wallet) from another chain through NEAR Intents 1Click
// (frontend-spec §4.7). Flow: pick asset + amount + refund address → live preview (dry quote) →
// one-time deposit address (QR) → live status until the tokens arrive on NEAR.
// The active deposit is kept in localStorage so a reload never loses the address.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { ArrowRight, Check, Copy, ExternalLink, Globe, Loader2, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { TxRunner } from "@/components/vault/tx-runner";
import { fetchIntentsQuote, fetchIntentsStatus, QuoteError, submitIntentsDeposit } from "@/lib/near/client";
import { explorerTxUrl } from "@/lib/near/config";
import { fc, type NearTx } from "@/lib/near/tx";
import {
  DESTINATION_ASSETS,
  ORIGIN_ASSETS,
  originLabel,
  validRefundAddress,
  type IntentsQuote,
  type IntentsStatus,
} from "@/lib/oneclick/assets";
import { useNow } from "@/lib/use-now";
import { DEMO } from "@/lib/demo";
import { cn } from "@/lib/utils";

export type FundTarget = { id: string; label: string; kind: "vault" | "wallet" };

type Active = { quote: IntentsQuote; createdAt: number };

const storeKey = (recipient: string) => `trellis:intents:active:${recipient}`;
function loadActive(recipient: string): Active | null {
  try {
    const raw = window.localStorage.getItem(storeKey(recipient));
    return raw ? (JSON.parse(raw) as Active) : null;
  } catch {
    return null;
  }
}
function saveActive(recipient: string, a: Active | null) {
  try {
    if (a) window.localStorage.setItem(storeKey(recipient), JSON.stringify(a));
    else window.localStorage.removeItem(storeKey(recipient));
  } catch {
    // storage blocked: the deposit still works, it just won't survive a reload
  }
}

const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export function IntentsDepositCard({
  targets,
  signer,
  prefill,
}: {
  /** Where funds can go (first = default). */
  targets: FundTarget[];
  /** Connected wallet (to register it on a token if needed). */
  signer?: string;
  prefill?: { originSymbol?: string; originChain?: string; amount?: string; destinationSymbol?: string; refundTo?: string };
}) {
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const target = targets.find((t) => t.id === targetId) ?? targets[0];
  // re-mount the inner card per target so its saved deposit is read fresh
  if (!target) return null;
  if (DEMO) {
    return (
      <div className="surface-card space-y-1.5 p-5 rounded-card">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-brand-purple" strokeWidth={2.4} />
          <h3 className="text-body-lg font-medium text-midnight-ink">Fund from another chain</h3>
          <Tag tone="violet">NEAR Intents</Tag>
        </div>
        <p className="text-body-sm text-muted-ash">
          {process.env.NEXT_PUBLIC_NEAR_NETWORK === "testnet"
            ? "Off on testnet: NEAR Intents only runs on mainnet, with real money."
            : "Off in demo mode: NEAR Intents moves real money on mainnet, and this demo's accounts only exist in the local sandbox."}{" "}
          On mainnet this card quotes BTC, ETH, SOL, USDC or USDT from Bitcoin, Ethereum, Base, Arbitrum or Solana and delivers to your vault.
        </p>
      </div>
    );
  }
  return (
    <div className="surface-card space-y-4 p-5 rounded-card">
      <div className="flex items-center gap-2">
        <Globe className="size-4 text-brand-purple" strokeWidth={2.4} />
        <h3 className="text-body-lg font-medium text-midnight-ink">Fund from another chain</h3>
        <Tag tone="violet">NEAR Intents</Tag>
      </div>
      {targets.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTargetId(t.id)}
              className={cn(
                "rounded-button px-3 py-1.5 text-caption font-medium ring-1",
                t.id === target.id ? "bg-midnight-ink text-canvas-white ring-midnight-ink" : "text-midnight-ink ring-hairline hover:ring-midnight-ink/30",
              )}
            >
              To {t.label}
            </button>
          ))}
        </div>
      )}
      <Inner key={target.id} target={target} signer={signer} prefill={prefill} />
    </div>
  );
}

function Inner({ target, signer, prefill }: { target: FundTarget; signer?: string; prefill?: Parameters<typeof IntentsDepositCard>[0]["prefill"] }) {
  const [active, setActive] = useState<Active | null>(() => loadActive(target.id));
  const update = (a: Active | null) => {
    saveActive(target.id, a);
    setActive(a);
  };
  return active ? (
    <DepositView active={active} target={target} onReset={() => update(null)} />
  ) : (
    <QuoteForm target={target} signer={signer} prefill={prefill} onDeposit={(q) => update({ quote: q, createdAt: Date.now() })} />
  );
}

// ── Step 1–2: form + live preview ────────────────────────────────────────

function QuoteForm({
  target,
  signer,
  prefill,
  onDeposit,
}: {
  target: FundTarget;
  signer?: string;
  prefill?: Parameters<typeof IntentsDepositCard>[0]["prefill"];
  onDeposit: (q: IntentsQuote) => void;
}) {
  const DEFAULT_ORIGIN = ORIGIN_ASSETS.find((a) => a.chain === "base" && a.symbol === "USDC")!;
  const wantSym = prefill?.originSymbol?.toLowerCase();
  const wantChain = prefill?.originChain?.toLowerCase();
  const initialOrigin =
    (wantSym || wantChain
      ? ORIGIN_ASSETS.find(
          (a) =>
            (!wantSym || a.symbol.toLowerCase() === wantSym) &&
            (!wantChain || a.chain === wantChain || a.chainLabel.toLowerCase() === wantChain),
        )
      : undefined) ?? DEFAULT_ORIGIN;
  const [originId, setOriginId] = useState(initialOrigin.id);
  const [destId, setDestId] = useState(
    DESTINATION_ASSETS.find((d) => d.symbol.toLowerCase() === prefill?.destinationSymbol?.toLowerCase())?.id ?? DESTINATION_ASSETS[0].id,
  );
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [refund, setRefund] = useState(prefill?.refundTo ?? "");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const origin = ORIGIN_ASSETS.find((a) => a.id === originId)!;
  const dest = DESTINATION_ASSETS.find((d) => d.id === destId)!;
  const refundOk = validRefundAddress(origin.addressKind, refund);
  const amountOk = Number(amount) > 0;

  // debounce the preview so typing doesn't spam 1Click
  const inputs = useMemo(
    () => ({ originAsset: originId, destinationAsset: destId, amount: amount.trim(), refundTo: refund.trim(), recipient: target.id }),
    [originId, destId, amount, refund, target.id],
  );
  const [debounced, setDebounced] = useState(inputs);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(inputs), 600);
    return () => window.clearTimeout(t);
  }, [inputs]);
  const ready = refundOk && amountOk && debounced === inputs;

  const preview = useQuery({
    queryKey: ["intents-preview", debounced],
    enabled: ready,
    queryFn: () => fetchIntentsQuote({ ...debounced, dry: true }),
    retry: false,
    staleTime: 20_000,
  });
  const notRegistered = preview.error instanceof QuoteError && preview.error.code === "not_registered" ? preview.error : null;

  async function create() {
    setCreating(true);
    setCreateError(null);
    try {
      onDeposit(await fetchIntentsQuote({ ...inputs, dry: false }));
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const select = "h-9 rounded-card bg-whisper-gray px-3 text-body-sm text-midnight-ink ring-1 ring-hairline";
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
        <label className="space-y-1">
          <span className="text-caption text-muted-ash">You send</span>
          <div className="flex gap-2">
            <select value={originId} onChange={(e) => setOriginId(e.target.value)} className={cn(select, "min-w-0 flex-1")}>
              {ORIGIN_ASSETS.map((a) => (
                <option key={a.id} value={a.id}>
                  {originLabel(a)}
                </option>
              ))}
            </select>
            <Input type="number" min={0} placeholder="Amount" className="w-28" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </label>
        <ArrowRight className="mx-auto hidden size-4 text-muted-ash sm:mb-2.5 sm:block" />
        <label className="space-y-1">
          <span className="text-caption text-muted-ash">{cap(target.label)} receives on NEAR</span>
          <select value={destId} onChange={(e) => setDestId(e.target.value)} className={cn(select, "w-full")}>
            {DESTINATION_ASSETS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.symbol}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-caption text-muted-ash">Your {origin.chainLabel} address (refunds go here if anything fails)</span>
        <Input placeholder={origin.addressKind === "evm" ? "0x…" : origin.addressKind === "btc" ? "bc1…" : "Solana address"} value={refund} onChange={(e) => setRefund(e.target.value)} className="font-mono" />
        {refund && !refundOk && <span className="text-caption text-destructive">That doesn&apos;t look like a {origin.chainLabel} address.</span>}
      </label>

      {/* preview */}
      <div className="surface-panel space-y-1 px-3.5 py-3 text-body-sm ring-1 ring-hairline rounded-card">
        {!refundOk || !amountOk ? (
          <p className="text-muted-ash">Enter an amount and your refund address to see a live quote.</p>
        ) : preview.isFetching || !ready ? (
          <p className="inline-flex items-center gap-1.5 text-muted-ash">
            <Loader2 className="size-3.5 animate-spin" /> Getting a quote from NEAR Intents…
          </p>
        ) : notRegistered ? (
          <RegisterNotice target={target} signer={signer} token={notRegistered.token ?? dest.token} symbol={dest.symbol} onDone={() => void preview.refetch()} />
        ) : preview.error ? (
          <p className="text-destructive">{preview.error.message}</p>
        ) : preview.data ? (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted-ash">{cap(target.label)} receives about</span>
              <span className="font-medium tabular-nums text-midnight-ink">
                {fmtNum(preview.data.amountOutFormatted)} {dest.symbol}
                {preview.data.amountOutUsd && <span className="ml-1 text-caption text-muted-ash">(${fmtNum(preview.data.amountOutUsd, 2)})</span>}
              </span>
            </div>
            <div className="flex justify-between gap-2 text-caption text-muted-ash">
              <span>At least {fmtNum(preview.data.minAmountOutFormatted)} {dest.symbol} (1% slippage)</span>
              <span>
                {feeText(preview.data)}
                {preview.data.timeEstimate ? ` · ≈ ${eta(preview.data.timeEstimate)}` : ""}
              </span>
            </div>
          </>
        ) : null}
      </div>

      {createError && <p className="text-caption text-destructive">{createError}</p>}
      <button
        type="button"
        disabled={!preview.data || creating}
        onClick={() => void create()}
        className="inline-flex items-center gap-1.5 bg-midnight-ink px-4 py-2 text-body-sm font-medium text-canvas-white rounded-button disabled:opacity-40"
      >
        {creating && <Loader2 className="size-4 animate-spin" />}
        Get deposit address
      </button>
      <p className="text-caption leading-snug text-muted-ash">
        NEAR Intents (1Click) swaps and bridges your funds and delivers {dest.symbol} straight to <span className="font-mono">{target.id}</span>. Every
        quote&apos;s 1Click signature is checked before it&apos;s shown.
      </p>
    </div>
  );
}

function RegisterNotice({ target, signer, token, symbol, onDone }: { target: FundTarget; signer?: string; token: string; symbol: string; onDone: () => void }) {
  if (target.kind === "vault") {
    return (
      <p className="text-muted-ash">
        Your vault can&apos;t receive {symbol} yet. Add {symbol} to the vault&apos;s allowed tokens in Rules (that registers it), then try again.
      </p>
    );
  }
  const tx: NearTx = {
    receiverId: token,
    actions: [fc("storage_deposit", { account_id: target.id, registration_only: true }, 10, "12500000000000000000000")],
    label: `Register your wallet for ${symbol}`,
    stepIds: ["register"],
  };
  return (
    <div className="space-y-2">
      <p className="text-muted-ash">Your wallet isn&apos;t registered for {symbol} yet (a one-time deposit of up to 0.0125 NEAR, mostly refunded).</p>
      {signer === target.id && <TxRunner txs={[tx]} cta={`Register for ${symbol}`} signer={signer} onDone={(r) => r.every((x) => x.ok) && onDone()} />}
    </div>
  );
}

// ── Step 3–4: deposit address + live status ───────────────────────────────

const STEPS = [
  { key: "PENDING_DEPOSIT", label: "Waiting for your deposit" },
  { key: "KNOWN_DEPOSIT_TX", label: "Deposit seen" },
  { key: "PROCESSING", label: "Swapping and delivering" },
  { key: "SUCCESS", label: "Arrived on NEAR" },
];
const stepIndex = (s: string) => (s === "INCOMPLETE_DEPOSIT" ? 1 : Math.max(0, STEPS.findIndex((x) => x.key === s)));

function DepositView({ active, target, onReset }: { active: Active; target: FundTarget; onReset: () => void }) {
  const q = active.quote;
  const origin = ORIGIN_ASSETS.find((a) => a.id === q.origin);
  const dest = DESTINATION_ASSETS.find((d) => d.id === q.destination);
  const now = useNow();
  const [txHash, setTxHash] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);

  const status = useQuery<IntentsStatus>({
    queryKey: ["intents-status", q.depositAddress],
    queryFn: () => fetchIntentsStatus(q.depositAddress!, q.depositMemo),
    enabled: !!q.depositAddress,
    refetchInterval: (query) => (query.state.data && TERMINAL.has(query.state.data.status) ? false : 5_000),
  });
  const s = status.data?.status ?? "PENDING_DEPOSIT";
  const idx = stepIndex(s);
  const deadlineMs = q.deadline ? Date.parse(q.deadline) : null;
  const left = deadlineMs ? deadlineMs - now : null;
  const expired = left !== null && left <= 0 && s === "PENDING_DEPOSIT";

  return (
    <div className="space-y-4">
      {s === "SUCCESS" ? (
        <div className="flex items-start gap-2 rounded-card bg-deliver-green/15 px-3.5 py-3 text-body-sm text-midnight-ink">
          <Check className="mt-0.5 size-4 shrink-0" strokeWidth={2.6} />
          <span>
            {fmtNum(status.data?.amountOutFormatted ?? q.amountOutFormatted)} {dest?.symbol} arrived in {target.label}.
          </span>
        </div>
      ) : s === "REFUNDED" || s === "FAILED" ? (
        <div className="flex items-start gap-2 rounded-card bg-destructive/10 px-3.5 py-3 text-body-sm text-midnight-ink">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            {s === "REFUNDED"
              ? `Refunded ${status.data?.refundedAmountFormatted ?? ""} ${origin?.symbol ?? ""} to your ${origin?.chainLabel} address${status.data?.refundReason ? ` (${status.data.refundReason})` : ""}.`
              : "The swap failed. 1Click refunds failed swaps to your refund address."}
          </span>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
          <div className="mx-auto rounded-card bg-canvas-white p-2.5 ring-1 ring-hairline">
            <QRCodeSVG value={q.depositAddress ?? ""} size={148} />
          </div>
          <div className="min-w-0 space-y-2">
            <div className="text-body-sm text-midnight-ink">
              Send exactly{" "}
              <span className="font-medium tabular-nums">
                {fmtNum(q.amountInFormatted)} {origin?.symbol}
              </span>{" "}
              on <span className="font-medium">{origin?.chainLabel}</span> to:
            </div>
            <CopyField value={q.depositAddress ?? ""} />
            {q.depositMemo && (
              <div className="space-y-1">
                <div className="text-caption font-medium text-destructive">Memo (required):</div>
                <CopyField value={q.depositMemo} />
              </div>
            )}
            <ul className="space-y-0.5 text-caption text-muted-ash">
              <li>
                Only {origin ? originLabel(origin) : "this asset"}. Other assets or chains sent here can be lost.
              </li>
              <li>
                {left !== null && left > 0 ? (
                  <>
                    Address valid for <span className="tabular-nums text-midnight-ink">{fmtLeft(left)}</span>; send well before then.
                  </>
                ) : expired ? (
                  <span className="text-destructive">This address has expired. Don&apos;t send to it; start a new deposit.</span>
                ) : null}
              </li>
              <li>
                {cap(target.label)} receives about {fmtNum(q.amountOutFormatted)} {dest?.symbol}
                {q.timeEstimate ? `, about ${eta(q.timeEstimate)} after your deposit confirms` : ""}.
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* status timeline */}
      <ol className="grid grid-cols-4 gap-1.5">
        {STEPS.map((step, i) => {
          const done = s === "SUCCESS" || i < idx;
          const current = i === idx && !TERMINAL.has(s);
          return (
            <li key={step.key} className="space-y-1">
              <div className={cn("h-1 rounded-full", done ? "bg-deliver-green" : current ? "bg-brand-purple animate-pulse" : "bg-midnight-ink/10")} />
              <div className={cn("text-[11px] leading-tight", done || current ? "text-midnight-ink" : "text-muted-ash")}>{step.label}</div>
            </li>
          );
        })}
      </ol>
      {s === "INCOMPLETE_DEPOSIT" && (
        <p className="text-caption text-destructive">Less than the quoted amount arrived. 1Click refunds it to your refund address after the deadline.</p>
      )}

      {(status.data?.originTxs.length || status.data?.nearTxs.length) ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-ash">
          {status.data.originTxs.map((t) => (
            <a key={t.hash} href={t.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-midnight-ink">
              {origin?.chainLabel} tx <ExternalLink className="size-3" />
            </a>
          ))}
          {status.data.nearTxs.map((h) => (
            <a key={h} href={explorerTxUrl(h)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-midnight-ink">
              NEAR tx <ExternalLink className="size-3" />
            </a>
          ))}
        </div>
      ) : null}

      {s === "PENDING_DEPOSIT" && !expired && (
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Sent it? Paste the tx hash to speed things up" value={txHash} onChange={(e) => setTxHash(e.target.value)} className="min-w-0 flex-1 font-mono text-caption" />
          <button
            type="button"
            disabled={!txHash.trim()}
            onClick={() =>
              void submitIntentsDeposit(txHash.trim(), q.depositAddress!)
                .then(() => setSubmitted("Thanks, 1Click is looking for it."))
                .catch((e: Error) => setSubmitted(e.message))
            }
            className="rounded-button px-3 py-2 text-caption font-medium text-midnight-ink ring-1 ring-hairline disabled:opacity-40"
          >
            Submit
          </button>
          {submitted && <span className="w-full text-caption text-muted-ash">{submitted}</span>}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-muted-ash">
          {status.isError ? `Status unavailable: ${status.error.message}` : TERMINAL.has(s) ? "" : "Updating every 5 s"}
        </span>
        <button type="button" onClick={onReset} className="text-caption font-medium text-muted-ash underline underline-offset-2 hover:text-midnight-ink">
          {TERMINAL.has(s) || expired ? "New deposit" : "Cancel and start over"}
        </button>
      </div>
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="flex w-full items-center gap-2 rounded-card bg-whisper-gray px-3 py-2 text-left ring-1 ring-hairline hover:ring-midnight-ink/30"
    >
      <span className="min-w-0 flex-1 break-all font-mono text-caption text-midnight-ink">{value}</span>
      {copied ? <Check className="size-3.5 shrink-0" /> : <Copy className="size-3.5 shrink-0 text-muted-ash" />}
    </button>
  );
}

// ── formatting ─────────────────────────────────────────────────────────────

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function fmtNum(s: string | undefined, max = 6) {
  const n = Number(s);
  if (!Number.isFinite(n)) return s ?? "";
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? Math.min(max, 4) : max });
}

function feeText(q: IntentsQuote) {
  const i = Number(q.amountInUsd);
  const o = Number(q.amountOutUsd);
  if (!Number.isFinite(i) || !Number.isFinite(o) || i <= 0) return "";
  const fee = Math.max(0, i - o);
  return `fees ≈ $${fee.toFixed(fee < 1 ? 3 : 2)} (${((fee / i) * 100).toFixed(2)}%)`;
}

function eta(sec: number) {
  return sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`;
}

function fmtLeft(ms: number) {
  const m = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${String(sec).padStart(2, "0")}s`;
}

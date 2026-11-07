"use client";

// Vault dashboard (frontend-spec §4.5): position + health, rules with today's
// limits, agent status, activity (receipts), owner controls.

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Pause, Play, ShieldOff, ArrowDownToLine, Pencil, Zap } from "lucide-react";
import { CinematicShell } from "@/components/parts/cinematic-shell";
import { WalletButton } from "@/components/wallet-button";
import { WalletCard } from "@/components/parts/wallet-card";
import { LendingPositionCard, hfLabel, hfTone } from "@/components/parts/lending-position-card";
import { ToolCallRow } from "@/components/parts/tool-call-row";
import { TxRunner } from "@/components/vault/tx-runner";
import { AwayBanner } from "@/components/vault/away-banner";
import { DemoControls } from "@/components/demo/demo-controls";
import { IntentsDepositCard } from "@/components/intents/intents-deposit-card";
import { StatusDisk } from "@/components/ui/status-disk";
import { Tag } from "@/components/ui/tag";
import { useNearAccount } from "@/lib/near/use-near-account";
import { useNow } from "@/lib/use-now";
import { iconFor, useVaultOf, useVaultState, type VaultState } from "@/lib/near/client";
import { clearDeleverageTx, closePositionTxs, hfFromBps, pauseTx, revokeTx, withdrawBalancesTx } from "@/lib/near/vault";
import { receiptAgo, receiptText } from "@/lib/near/receipt-text";
import { fromBase, toBase, type NearTx } from "@/lib/near/tx";
import { fmtPct, fmtUsd } from "@/lib/format";
import { explorerTxUrl } from "@/lib/near/config";
import { VAULT_TOKENS, policyToRules, rulesSummary } from "@/lib/vault-presets";
import { cn } from "@/lib/utils";

export default function VaultPage() {
  const { accountId, loading } = useNearAccount();
  const vaultOf = useVaultOf(accountId);
  const vaultId = vaultOf.data?.vaultId;
  const state = useVaultState(vaultId);

  return (
    <CinematicShell mode="dim">
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 px-4 pt-24 pb-10 sm:px-6">
        <h1 className="font-alt text-title font-medium tracking-tight text-midnight-ink">Your vault</h1>
        {!accountId ? (
          <div className="surface-card flex flex-col items-start gap-3 p-5 rounded-card">
            <p className="text-body-sm text-muted-ash">{loading ? "Checking your wallet…" : "Connect the wallet that owns your vault."}</p>
            {!loading && <WalletButton />}
          </div>
        ) : vaultOf.isPending ? (
          <ToolCallRow label="Looking up your vault…" status="input-available" />
        ) : vaultOf.isError ? (
          <ToolCallRow label={vaultOf.error.message} status="output-error" />
        ) : !vaultId ? (
          <div className="surface-card space-y-2 p-5 rounded-card">
            <p className="text-body-sm text-midnight-ink">You don&apos;t have a Trellis vault yet.</p>
            <Link href="/vault/setup" className="inline-flex bg-midnight-ink px-4 py-2 text-body-sm font-medium text-canvas-white rounded-button">
              Create one
            </Link>
          </div>
        ) : state.isPending ? (
          <ToolCallRow label="Reading your vault…" status="input-available" />
        ) : state.isError ? (
          <ToolCallRow label={state.error.message} status="output-error" />
        ) : (
          <Dashboard s={state.data} accountId={accountId} />
        )}
      </main>
    </CinematicShell>
  );
}

function Dashboard({ s, accountId }: { s: VaultState; accountId: string }) {
  const qc = useQueryClient();
  const now = useNow();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["vault-state", s.vaultId] });
  const p = s.position;
  const walletUsd = s.balances.totalUsd;
  const coll = p.totalCollateralUsd ?? 0;
  const debt = p.totalDebtUsd ?? 0;
  const equity = coll - debt;
  const leverage = equity > 0 && coll > 0 ? coll / equity : 1;
  const yearly =
    p.collateral.reduce((a, l) => a + (l.valueUsd ?? 0) * l.aprPct, 0) -
    p.borrowed.reduce((a, l) => a + (l.valueUsd ?? 0) * l.aprPct, 0);
  const netApy = equity > 0 ? yearly / equity : 0;
  const tone = hfTone(p.healthFactor);
  const agentExpired = s.status.agent_expires_at && BigInt(s.status.agent_expires_at) < BigInt(now) * BigInt(1e6);

  return (
    <div className="space-y-4">
      <DemoControls />
      <AwayBanner key={s.vaultId} vaultId={s.vaultId} receipts={s.receipts} currentHf={p.healthFactor} />
      <div className="grid gap-2 sm:grid-cols-4">
        <Hero label="Net value" value={fmtUsd(walletUsd + (p.netValueUsd ?? 0))} />
        <Hero label="Health factor" value={p.healthFactor === null ? "∞" : p.healthFactor.toFixed(2)} tag={hfLabel(p.healthFactor)} tone={tone} />
        <Hero label="Leverage" value={`${leverage.toFixed(2)}x`} />
        <Hero label="Net APY (rates only)" value={equity > 0 ? fmtPct(netApy) : "—"} />
      </div>

      {/* columns stretch to the same height; the rules card grows so both bottoms line up */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <LendingPositionCard position={p} iconLookup={iconFor} fill />
          <WalletCard accountId={s.vaultId} balances={s.balances.balances} iconLookup={iconFor} fill />
        </div>
        <div className="flex flex-col gap-4">
          <AgentCard s={s} expired={!!agentExpired} />
          <RulesCard s={s} />
        </div>
      </div>

      <Activity s={s} />

      <Controls s={s} accountId={accountId} onDone={refresh} />
      <IntentsDepositCard
        targets={[
          { id: s.vaultId, label: "your vault", kind: "vault" },
          { id: accountId, label: "your wallet", kind: "wallet" },
        ]}
        signer={accountId}
      />
    </div>
  );
}

function Hero({ label, value, tag, tone }: { label: string; value: string; tag?: string; tone?: "green" | "gold" | "red" | "neutral" }) {
  return (
    <div className="surface-card px-4 py-3 rounded-card">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-ash">{label}</div>
      <div className="flex items-center gap-2">
        <span className="text-display-sm font-medium tabular-nums text-midnight-ink">{value}</span>
        {tag && <Tag tone={tone ?? "neutral"}>{tag}</Tag>}
      </div>
    </div>
  );
}

function AgentCard({ s, expired }: { s: VaultState; expired: boolean }) {
  const st = s.status;
  const label = !st.agent ? "Revoked / not set" : st.paused ? "Paused" : expired ? "Expired" : "Active";
  return (
    <div className="surface-card flex items-center gap-3 p-4 rounded-card">
      <StatusDisk tone={label === "Active" ? "green" : "gold"}>
        <Bot className="size-4" strokeWidth={2.4} />
      </StatusDisk>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-body-sm font-medium text-midnight-ink">Agent: {label}</div>
        <div className="truncate text-caption text-muted-ash">
          {st.agent ?? "no agent"}
          {st.agent_expires_at ? ` · until ${new Date(Number(BigInt(st.agent_expires_at) / BigInt(1e6))).toLocaleDateString()}` : ""}
          {st.in_flight ? ` · running ${st.in_flight.kind}` : ""}
          {st.pending_deleverage ? " · finishing a deleverage (swap, then repay)" : ""}
        </div>
      </div>
      {st.last_health && <Tag>last HF {hfFromBps(st.last_health.health_factor_bps)?.toFixed(2) ?? "∞"}</Tag>}
    </div>
  );
}

function RulesCard({ s }: { s: VaultState }) {
  if (!s.policy || s.policy.allowed_tokens.length === 0) {
    return (
      <div className="surface-card space-y-2 p-4 rounded-card">
        <div className="text-body-sm text-midnight-ink">No rules yet: the agent can&apos;t do anything.</div>
        <Link href="/vault/setup?step=rules" className="text-body-sm font-medium underline underline-offset-2">
          Set rules
        </Link>
      </div>
    );
  }
  const rules = policyToRules(s.policy);
  return (
    <div className="surface-card flex-1 space-y-3 p-4 rounded-card">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-ash">Rules</div>
      <p className="text-body-sm text-midnight-ink">{rulesSummary(rules)}</p>
      <div className="space-y-2">
        {s.policy.daily_cap.map(([t, cap]) => {
          const meta = VAULT_TOKENS.find((v) => v.id === t);
          const d = meta?.decimals ?? 24;
          const left = fromBase(s.remaining[t] ?? cap, d);
          const total = fromBase(cap, d);
          const used = Math.max(0, total - left);
          const pct = total > 0 ? (used / total) * 100 : 0;
          return (
            <div key={t} className="space-y-1">
              <div className="flex justify-between text-caption">
                <span className="text-midnight-ink">{meta?.symbol ?? t} today</span>
                <span className="tabular-nums text-muted-ash">
                  {used.toLocaleString("en-US", { maximumFractionDigits: 4 })} / {total.toLocaleString("en-US")} used
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-midnight-ink/[0.06]">
                {/* runtime-dynamic width (allowed inline-style carve-out) */}
                <div className={cn("h-full rounded-full", pct > 90 ? "bg-destructive" : pct > 60 ? "bg-warning" : "bg-deliver-green")} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Activity({ s }: { s: VaultState }) {
  return (
    <div className="surface-card space-y-2 p-4 rounded-card">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-ash">Agent activity</div>
      {s.receipts.length === 0 ? (
        <p className="text-body-sm text-muted-ash">No agent actions yet.</p>
      ) : (
        <ul className="space-y-1">
          {s.receipts.map((r) => (
            <li key={r.op_id} className="flex items-start gap-2 surface-panel px-3 py-2 rounded-card">
              <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", r.status === "Settled" ? "bg-deliver-green" : "bg-destructive")} />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="flex items-center gap-1.5 text-body-sm text-midnight-ink">
                  <span className="min-w-0">{receiptText(r)}</span>
                  {r.origin === "auto" && (
                    <span title={r.why ? `Automatic: ${r.why}` : "Automatic protection"} className="inline-flex shrink-0 items-center gap-0.5 rounded-card bg-brand-orange/15 px-1.5 text-[10px] font-medium uppercase tracking-wider text-brand-orange">
                      <Zap className="size-2.5" strokeWidth={2.6} /> Auto
                    </span>
                  )}
                  {r.origin === "plan" && <Tag>You approved</Tag>}
                </div>
                <div className="truncate text-caption text-muted-ash">
                  {r.status === "Failed" ? `Failed${r.note ? `: ${r.note}` : ""}` : r.origin === "auto" && r.why ? r.why : r.note || "Settled"}
                  {r.health_factor_bps && hfFromBps(r.health_factor_bps) !== null ? ` · HF ${hfFromBps(r.health_factor_bps)!.toFixed(2)}` : ""}
                </div>
              </div>
              <span className="flex shrink-0 flex-col items-end text-caption text-muted-ash">
                {receiptAgo(r)}
                {r.tx_hash && (
                  <a href={explorerTxUrl(r.tx_hash)} target="_blank" rel="noreferrer" className="hover:text-midnight-ink">
                    tx ↗
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Controls({ s, accountId, onDone }: { s: VaultState; accountId: string; onDone: () => void }) {
  const [open, setOpen] = useState<null | "pause" | "revoke" | "withdraw" | "cycle">(null);
  const isOwner = s.status.owner === accountId;
  const p = s.position;
  const hasPosition = p.collateral.length + p.borrowed.length + p.supplied.length > 0;

  let withdrawTxs: NearTx[] = [];
  let withdrawNote = "";
  if (hasPosition) {
    const debt = p.borrowed[0];
    if (p.borrowed.length > 1) {
      withdrawNote = "The vault owes more than one token. Ask Trellis to deleverage first, then withdraw.";
    } else if (debt) {
      const meta = VAULT_TOKENS.find((v) => v.id === debt.tokenId);
      const have = s.balances.balances.find((b) => b.tokenId === debt.tokenId);
      const needed = debt.amount * 1.001 + 1 / 10 ** (meta?.decimals ?? 6);
      if (!meta || !have || have.balance < needed) {
        withdrawNote = `The vault owes ${debt.amount.toFixed(4)} ${debt.symbol} but doesn't hold enough to repay it. Ask Trellis to deleverage (or deposit ${debt.symbol} to the vault), then withdraw.`;
      } else {
        withdrawTxs = closePositionTxs(s.vaultId, {
          repay: { tokenId: debt.tokenId, amountBase: toBase(needed.toFixed(meta.decimals), meta.decimals).toString() },
          collateralTokens: p.collateral.map((l) => l.tokenId),
          suppliedTokens: [...p.supplied.map((l) => l.tokenId), debt.tokenId],
          hasDebt: true,
        });
        withdrawNote = "Step 1 closes the Rhea position into the vault. Then come back and withdraw the vault's balances.";
      }
    } else {
      withdrawTxs = closePositionTxs(s.vaultId, {
        collateralTokens: p.collateral.map((l) => l.tokenId),
        suppliedTokens: p.supplied.map((l) => l.tokenId),
        hasDebt: false,
      });
      withdrawNote = "Step 1 closes the Rhea position into the vault. Then come back and withdraw the vault's balances.";
    }
  } else {
    const ft = s.balances.balances
      .filter((b) => b.tokenId !== "near" && b.verified && BigInt(b.balanceRaw) > BigInt(0))
      .map((b) => ({ tokenId: b.tokenId, amountBase: b.balanceRaw }));
    // Keep 0.05 NEAR so in-flight callbacks / storage stay covered.
    const near = BigInt(s.status.near_available) - toBase("0.05", 24);
    withdrawTxs = ft.length > 0 || near > BigInt(0) ? [withdrawBalancesTx(s.vaultId, ft, near > BigInt(0) ? near.toString() : undefined)] : [];
    withdrawNote = withdrawTxs.length ? "Sends every token and the vault's spare NEAR to your wallet." : "Nothing to withdraw.";
  }

  const btn = "inline-flex items-center gap-1.5 surface-card px-3 py-2 text-body-sm font-medium text-midnight-ink rounded-button ring-1 ring-hairline hover:ring-midnight-ink/30 disabled:opacity-50";
  return (
    <div className="surface-card space-y-3 p-4 rounded-card">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-ash">Owner controls (each needs your wallet)</div>
      {!isOwner && <p className="text-body-sm text-muted-ash">Connected as {accountId}; only {s.status.owner} can use these.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={!isOwner} onClick={() => setOpen("pause")}>
          {s.status.paused ? <Play className="size-4" /> : <Pause className="size-4" />} {s.status.paused ? "Resume agent" : "Pause agent"}
        </button>
        <button type="button" className={btn} disabled={!isOwner || !s.status.agent} onClick={() => setOpen("revoke")}>
          <ShieldOff className="size-4" /> Revoke agent
        </button>
        <button type="button" className={btn} disabled={!isOwner} onClick={() => setOpen("withdraw")}>
          <ArrowDownToLine className="size-4" /> Withdraw all
        </button>
        <Link href="/vault/setup?step=rules" className={btn}>
          <Pencil className="size-4" /> Edit rules
        </Link>
        {s.status.pending_deleverage && (
          <button type="button" className={btn} disabled={!isOwner} onClick={() => setOpen("cycle")}>
            <ShieldOff className="size-4" /> End deleverage cycle
          </button>
        )}
      </div>
      {open === "pause" && <TxRunner txs={[pauseTx(s.vaultId, !s.status.paused)]} cta={s.status.paused ? "Resume" : "Pause"} signer={accountId} onDone={onDone} />}
      {open === "revoke" && (
        <div className="space-y-2">
          <p className="text-caption text-muted-ash">Instant: the agent can no longer call anything. Set it again from Edit rules.</p>
          <TxRunner txs={[revokeTx(s.vaultId)]} cta="Revoke" signer={accountId} onDone={onDone} />
        </div>
      )}
      {open === "cycle" && (
        <div className="space-y-2">
          <p className="text-caption text-muted-ash">
            After a protective withdrawal the agent may only swap that collateral and repay. End the cycle if you finished it
            yourself (repaid or added collateral); the agent can then act normally again.
          </p>
          <TxRunner txs={[clearDeleverageTx(s.vaultId)]} cta="End cycle" signer={accountId} onDone={onDone} />
        </div>
      )}
      {open === "withdraw" && (
        <div className="space-y-2">
          <p className="text-caption text-muted-ash">{withdrawNote}</p>
          {withdrawTxs.length > 0 && <TxRunner txs={withdrawTxs} cta={hasPosition ? "Close position" : "Withdraw to wallet"} signer={accountId} onDone={onDone} />}
        </div>
      )}
    </div>
  );
}

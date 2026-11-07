"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CinematicShell } from "@/components/parts/cinematic-shell";
import { WalletButton } from "@/components/wallet-button";
import { WalletCard } from "@/components/parts/wallet-card";
import { LendingPositionCard, hfLabel, hfTone } from "@/components/parts/lending-position-card";
import { ToolCallRow } from "@/components/parts/tool-call-row";
import { Tag } from "@/components/ui/tag";
import { useNearAccount } from "@/lib/near/use-near-account";
import { iconFor, useBalances, useLendingPosition, useVaultOf, useVaultState } from "@/lib/near/client";
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Portfolio: everything you own across your wallet and your Trellis vault.
 * Summary (total value, vault health, leverage), the vault's Rhea position,
 * wallet balances, and the wallet's own Rhea position when it has one.
 */
export default function PortfolioPage() {
  const { accountId, loading } = useNearAccount();
  const balances = useBalances(accountId);
  const position = useLendingPosition(accountId);
  const vaultOf = useVaultOf(accountId);
  const vaultId = vaultOf.data?.vaultId ?? null;
  const vault = useVaultState(vaultId);

  const walletUsd = balances.data?.totalUsd ?? 0;
  const vs = vault.data;
  const vaultUsd = vs ? vs.balances.totalUsd + (vs.position.netValueUsd ?? 0) : 0;
  const ownPositionUsd = position.data?.registered ? (position.data.netValueUsd ?? 0) : 0;
  const total = walletUsd + vaultUsd + ownPositionUsd;
  const coll = vs?.position.totalCollateralUsd ?? 0;
  const debt = vs?.position.totalDebtUsd ?? 0;
  const leverage = coll > 0 && coll - debt > 0 ? coll / (coll - debt) : null;
  const hf = vs?.position.healthFactor ?? null;
  const ownHasPosition =
    !!position.data && position.data.collateral.length + position.data.borrowed.length + position.data.supplied.length > 0;

  return (
    <CinematicShell mode="dim">
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 px-4 pt-24 pb-10 sm:px-6">
        <h1 className="font-alt text-title font-medium tracking-tight text-midnight-ink">Portfolio</h1>
        {!accountId ? (
          <div className="surface-card flex flex-col items-start gap-3 p-5 rounded-card">
            <p className="text-body-sm text-muted-ash">
              {loading ? "Checking your wallet…" : "Connect a NEAR wallet to see your balances, your vault and your Rhea Lending position."}
            </p>
            {!loading && <WalletButton />}
          </div>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-4">
              <Stat label="Total value" value={balances.isPending ? "…" : usd(total)} />
              <Stat label="In your wallet" value={balances.isPending ? "…" : usd(walletUsd)} />
              <Stat label="In your vault" value={vaultId ? (vault.isPending ? "…" : usd(vaultUsd)) : "—"} />
              <Stat
                label={vs ? `Vault health · ${leverage ? leverage.toFixed(2) : "1.00"}x leverage` : "Vault health"}
                value={vs ? (hf === null ? "∞" : hf.toFixed(2)) : "—"}
                tag={vs ? hfLabel(hf) : undefined}
                tone={hfTone(hf)}
              />
            </div>

            {vaultId && (
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted-ash">Your vault · {vaultId}</h2>
                  <Link href="/vault" className="inline-flex items-center gap-1 text-caption font-medium text-midnight-ink hover:underline">
                    Open vault <ArrowRight className="size-3.5" />
                  </Link>
                </div>
                {vault.isPending ? (
                  <ToolCallRow label="Reading your vault…" status="input-available" />
                ) : vault.isError ? (
                  <ToolCallRow label={`Vault read failed: ${vault.error.message}`} status="output-error" />
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 md:items-start">
                    <LendingPositionCard position={vault.data.position} iconLookup={iconFor} fill />
                    <WalletCard accountId={vaultId} balances={vault.data.balances.balances} iconLookup={iconFor} fill />
                  </div>
                )}
              </section>
            )}

            <section className="space-y-2">
              <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted-ash">Your wallet · {accountId}</h2>
              <div className="grid gap-4 md:grid-cols-2 md:items-start">
                {balances.isPending ? (
                  <ToolCallRow label="Reading balances…" status="input-available" />
                ) : balances.isError ? (
                  <ToolCallRow label={`Balance read failed: ${balances.error.message}`} status="output-error" />
                ) : (
                  <WalletCard accountId={accountId} balances={balances.data.balances} iconLookup={iconFor} fill />
                )}
                {position.isPending ? (
                  <ToolCallRow label="Reading Rhea Lending position…" status="input-available" />
                ) : position.isError ? (
                  <ToolCallRow label={`Position read failed: ${position.error.message}`} status="output-error" />
                ) : ownHasPosition ? (
                  <LendingPositionCard position={position.data} iconLookup={iconFor} fill />
                ) : (
                  <div className="surface-card space-y-2 p-5 rounded-card">
                    <div className="text-body-sm font-medium text-midnight-ink">No Rhea Lending position in your wallet</div>
                    <p className="text-caption text-muted-ash">
                      {vaultId
                        ? "Your leveraged position lives in your vault, where the agent protects it inside your rules."
                        : "Create a vault to let the Trellis agent manage and protect a position inside your rules."}
                    </p>
                    <Link href={vaultId ? "/vault" : "/vault/setup"} className="inline-flex items-center gap-1 text-caption font-medium text-midnight-ink hover:underline">
                      {vaultId ? "Open vault" : "Create a vault"} <ArrowRight className="size-3.5" />
                    </Link>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </CinematicShell>
  );
}

function Stat({ label, value, tag, tone }: { label: string; value: string; tag?: string; tone?: "green" | "gold" | "red" | "neutral" }) {
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

"use client";

// Vault setup wizard (frontend-spec §3.3, §4.6): Create → Rules → Fund.

import { IntentsDepositCard } from "@/components/intents/intents-deposit-card";
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { CinematicShell } from "@/components/parts/cinematic-shell";
import { WalletButton } from "@/components/wallet-button";
import { RulesFormView } from "@/components/vault/rules-form";
import { TxRunner } from "@/components/vault/tx-runner";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { signedFetch } from "@/lib/api-client";
import { useNearAccount } from "@/lib/near/use-near-account";
import { useTrellisSession } from "@/lib/near/use-session";
import { useVaultOf, useVaultState } from "@/lib/near/client";
import { TRELLIS_AGENT } from "@/lib/near/config";
import { fromBase, toBase } from "@/lib/near/tx";
import { createVaultTx, fundTx, rulesTxs } from "@/lib/near/vault";
import {
  PRESETS,
  VAULT_TOKENS,
  decodeRules,
  policyToRules,
  rulesToPolicy,
  validateRules,
  type RulesForm,
} from "@/lib/vault-presets";
import { cn } from "@/lib/utils";

type Step = "create" | "rules" | "fund";

export default function VaultSetupPage() {
  return (
    <Suspense>
      <Setup />
    </Suspense>
  );
}

function Setup() {
  const params = useSearchParams();
  const { accountId, loading } = useNearAccount();
  const vaultOf = useVaultOf(accountId);
  const vaultId = vaultOf.data?.vaultId ?? null;
  const state = useVaultState(vaultId);
  const qc = useQueryClient();
  const { ensure } = useTrellisSession(accountId);
  const [step, setStep] = useState<Step | null>(null);
  const [monitorNote, setMonitorNote] = useState<string | null>(null);

  const prefill = useMemo(() => decodeRules(params.get("rules")), [params]);
  const [form, setForm] = useState<RulesForm>(() => prefill ?? { ...PRESETS.balanced });
  const [formTouched, setFormTouched] = useState(!!prefill);
  // Editing existing rules: start from the on-chain policy unless a prefill was given.
  const policy = state.data?.policy;
  const onChainRules = policy && policy.allowed_tokens.length > 0 ? policyToRules(policy) : null;
  const shownForm = formTouched || !onChainRules ? form : onChainRules;

  const hasRules = !!state.data?.policy && state.data.policy.allowed_tokens.length > 0;
  const current: Step =
    step ?? (!vaultId ? "create" : params.get("step") === "fund" || (hasRules && !prefill && params.get("step") !== "rules") ? "fund" : "rules");

  async function registerWithWorker() {
    try {
      await ensure();
      const r = await signedFetch("/api/vault/register", { method: "POST" });
      const j = await r.json();
      setMonitorNote(r.ok ? "The Trellis agent is now watching your vault's health." : `Agent monitoring not set up yet: ${j.error}`);
    } catch (e) {
      setMonitorNote(`Agent monitoring not set up yet: ${(e as Error).message}`);
    }
  }

  return (
    <CinematicShell mode="dim">
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 px-4 pt-24 pb-10 sm:px-6">
        <div className="flex items-center justify-between">
          <h1 className="font-alt text-title font-medium tracking-tight text-midnight-ink">Set up your vault</h1>
          {vaultId && (
            <Link href="/vault" className="text-body-sm font-medium text-muted-ash hover:text-midnight-ink">
              Dashboard →
            </Link>
          )}
        </div>

        {!accountId ? (
          <div className="surface-card flex flex-col items-start gap-3 p-5 rounded-card">
            <p className="text-body-sm text-muted-ash">{loading ? "Checking your wallet…" : "Connect the NEAR wallet that will own the vault."}</p>
            {!loading && <WalletButton />}
          </div>
        ) : vaultOf.isError ? (
          <div className="surface-card p-5 text-body-sm text-destructive rounded-card">{vaultOf.error.message}</div>
        ) : (
          <>
            <div className="flex gap-2">
              {(["create", "rules", "fund"] as Step[]).map((s, i) => (
                <button
                  key={s}
                  type="button"
                  disabled={s !== "create" && !vaultId}
                  onClick={() => setStep(s)}
                  className={cn(
                    "flex-1 surface-card px-3 py-2 text-left text-body-sm rounded-card ring-1 disabled:opacity-50",
                    current === s ? "ring-midnight-ink" : "ring-transparent",
                  )}
                >
                  <span className="text-muted-ash">{i + 1}. </span>
                  <span className="font-medium capitalize text-midnight-ink">{s}</span>
                  {s === "create" && vaultId && <Tag tone="green" className="ml-2">done</Tag>}
                  {s === "rules" && hasRules && <Tag tone="green" className="ml-2">set</Tag>}
                </button>
              ))}
            </div>

            {current === "create" && (
              <section className="surface-card space-y-3 p-5 rounded-card">
                <h2 className="text-body-lg font-medium text-midnight-ink">Create your vault</h2>
                <ul className="list-disc space-y-1 pl-5 text-body-sm text-midnight-ink">
                  <li>A smart contract account that only you control. It holds your funds and your Rhea Lending position.</li>
                  <li>The Trellis agent can act only inside rules you set, enforced by the contract. Funds can only go to Rhea, Ref, or back to you.</li>
                  <li>Pause, revoke the agent, or withdraw everything any time with your wallet.</li>
                </ul>
                {vaultId ? (
                  <p className="text-body-sm text-midnight-ink">
                    Your vault is <span className="font-mono">{vaultId}</span>.
                  </p>
                ) : vaultOf.data ? (
                  <>
                    <p className="text-body-sm text-muted-ash">
                      It will be <span className="font-mono text-midnight-ink">{vaultOf.data.predictedId}</span>. Creating it moves{" "}
                      <span className="font-medium text-midnight-ink">{fromBase(vaultOf.data.minDeposit, 24)} NEAR</span> into the vault for its
                      storage and gas reserve (yours, withdrawable).
                    </p>
                    <TxRunner
                      txs={[createVaultTx(vaultOf.data.minDeposit)]}
                      cta="Create vault"
                      signer={accountId}
                      onDone={async (res) => {
                        if (!res[0]?.ok) return;
                        await qc.invalidateQueries({ queryKey: ["vault-of", accountId] });
                        setStep("rules");
                        void registerWithWorker();
                      }}
                    />
                  </>
                ) : (
                  <p className="text-body-sm text-muted-ash">Reading the factory…</p>
                )}
                {monitorNote && <p className="text-caption text-muted-ash">{monitorNote}</p>}
              </section>
            )}

            {current === "rules" && vaultId && (
              <section className="surface-card space-y-4 p-5 rounded-card">
                <div className="flex items-center justify-between">
                  <h2 className="text-body-lg font-medium text-midnight-ink">Rules for the agent</h2>
                  {prefill && <Tag tone="green">prefilled by Trellis</Tag>}
                </div>
                <RulesFormView
                  value={shownForm}
                  onChange={(f) => {
                    setFormTouched(true);
                    setForm(f);
                  }}
                />
                {state.data ? (
                  <RulesSave vaultId={vaultId} form={shownForm} accountId={accountId} registered={state.data.tokens.map(([t]) => t)} protocolsReady={state.data.protocolsReady} onDone={() => {
                    void qc.invalidateQueries({ queryKey: ["vault-state", vaultId] });
                    setStep("fund");
                  }} />
                ) : (
                  <p className="text-body-sm text-muted-ash">Reading your vault…</p>
                )}
                {!monitorNote && (
                  <button type="button" onClick={() => void registerWithWorker()} className="text-caption text-muted-ash underline underline-offset-2">
                    Make sure the agent is watching this vault
                  </button>
                )}
                {monitorNote && <p className="text-caption text-muted-ash">{monitorNote}</p>}
              </section>
            )}

            {current === "fund" && vaultId && (
              <FundSection vaultId={vaultId} accountId={accountId} registered={state.data?.tokens.map(([t]) => t) ?? []} />
            )}
          </>
        )}
      </main>
    </CinematicShell>
  );
}

function RulesSave({
  vaultId,
  form,
  accountId,
  registered,
  protocolsReady,
  onDone,
}: {
  vaultId: string;
  form: RulesForm;
  accountId: string;
  registered: string[];
  protocolsReady: boolean;
  onDone: () => void;
}) {
  const [openedAt] = useState(() => Date.now());
  const errors = validateRules(form);
  const toRegister = form.tokens.filter((t) => !registered.includes(t));
  const txs =
    errors.length > 0
      ? []
      : rulesTxs({
          vaultId,
          policy: rulesToPolicy(form),
          agentExpiresAtNs:
            form.agentExpiryDays > 0
              ? (BigInt(openedAt + form.agentExpiryDays * 86_400_000) * BigInt(1_000_000)).toString()
              : null,
          tokensToRegister: toRegister,
          // Ref must also register newly added tokens, so re-run when adding any.
          needsProtocolSetup: !protocolsReady || toRegister.length > 0,
        });
  return (
    <div className="space-y-2">
      <p className="text-caption text-muted-ash">
        Saving authorizes <span className="font-mono">{TRELLIS_AGENT}</span> as your vault&apos;s agent. Each call attaches 1 yoctoNEAR so only your wallet can make it.
      </p>
      <TxRunner txs={txs} cta="Save rules" disabled={errors.length > 0} signer={accountId} onDone={(res) => res.every((r) => r.ok) && onDone()} />
    </div>
  );
}

function FundSection({ vaultId, accountId, registered }: { vaultId: string; accountId: string; registered: string[] }) {
  const [tab, setTab] = useState<"wallet" | "chain">("wallet");
  const options = [
    { id: "near", symbol: "NEAR", decimals: 24 },
    ...VAULT_TOKENS.filter((t) => registered.includes(t.id)),
  ];
  const [tokenId, setTokenId] = useState("near");
  const [amount, setAmount] = useState("");
  const tok = options.find((o) => o.id === tokenId) ?? options[0];
  let amountBase: string | null = null;
  try {
    amountBase = Number(amount) > 0 ? toBase(amount, tok.decimals).toString() : null;
  } catch {
    amountBase = null;
  }
  return (
    <section className="surface-card space-y-4 p-5 rounded-card">
      <h2 className="text-body-lg font-medium text-midnight-ink">Fund the vault</h2>
      <div className="flex gap-2">
        {(["wallet", "chain"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn("rounded-button px-3 py-1.5 text-body-sm font-medium", tab === t ? "bg-midnight-ink text-canvas-white" : "text-muted-ash hover:text-midnight-ink")}
          >
            {t === "wallet" ? "From NEAR wallet" : "From another chain"}
          </button>
        ))}
      </div>
      {tab === "wallet" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={tokenId}
              onChange={(e) => setTokenId(e.target.value)}
              className="h-9 rounded-card bg-whisper-gray px-3 text-body-sm text-midnight-ink ring-1 ring-hairline"
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.symbol}
                </option>
              ))}
            </select>
            <Input type="number" min={0} placeholder="Amount" className="w-40" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {registered.length === 0 && (
            <p className="text-caption text-muted-ash">Save rules first so the vault can accept tokens (it refunds tokens it hasn&apos;t registered).</p>
          )}
          {tokenId === "near" && (
            <p className="text-caption text-muted-ash">NEAR stays native in the vault; the agent wraps it into wNEAR when a plan needs it.</p>
          )}
          <TxRunner txs={amountBase ? [fundTx(vaultId, tokenId, amountBase)] : []} cta="Deposit" disabled={!amountBase} signer={accountId} />
        </div>
      ) : (
        <IntentsDepositCard targets={[{ id: vaultId, label: "your vault", kind: "vault" }]} signer={accountId} />
      )}
    </section>
  );
}

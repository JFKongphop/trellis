"use client";

// Vault page in demo mode: move the sandbox oracle's NEAR price to watch the agent protect the position.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Loader2, TrendingDown, RotateCcw } from "lucide-react";
import { DEMO, DEMO_REPLAY, DEMO_TESTNET } from "@/lib/demo";
import { postJson } from "@/lib/near/client";
import { useDemoInfo } from "@/lib/near/use-near-account";
import { cn } from "@/lib/utils";

const PRESETS = [
  { usd: 1.75, label: "Crash NEAR to $1.75", hint: "HF falls below the 1.3 trigger: the agent deleverages on its own", icon: TrendingDown, strong: true },
  { usd: 3, label: "Drop to $3.00", hint: "HF still above the trigger: the agent waits", icon: TrendingDown, strong: false },
];

export function DemoControls() {
  const info = useDemoInfo();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!DEMO) return null;

  async function setPrice(usd: number) {
    setBusy(usd);
    setError(null);
    try {
      await postJson("/api/demo/price", { nearUsd: usd });
      await qc.invalidateQueries({ queryKey: ["demo-info"] });
      await qc.invalidateQueries({ queryKey: ["vault-state"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const now = info.data?.nearUsd;
  const start = info.data?.startNearUsd ?? 5;
  const btn = "inline-flex items-center gap-1.5 rounded-button px-3 py-2 text-body-sm font-medium ring-1 transition-colors disabled:opacity-50";
  return (
    <div className="surface-card space-y-3 p-4 ring-1 ring-brand-orange/40 rounded-card">
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="size-4 text-brand-orange" strokeWidth={2.4} />
        <span className="text-body-sm font-medium text-midnight-ink">Demo controls</span>
        <span className="text-caption text-muted-ash">
          Oracle NEAR price: <span className="tabular-nums text-midnight-ink">{now !== undefined ? `$${now.toFixed(2)}` : "…"}</span>
        </span>
      </div>
      <p className="text-caption leading-snug text-muted-ash">
        {DEMO_REPLAY && DEMO_TESTNET
          ? "Replay of the recorded NEAR testnet run (Rhea and Ref running their mainnet code; the agent's key held in OutLayer's TEE). \"Crash\" replays what the agent did when NEAR fell to $1.75: three protective moves a few seconds apart, inside your rules and with no signature from you. Each move's tx ↗ opens the real transaction on testnet.nearblocks.io. Nothing is signed here."
          : DEMO_REPLAY
          ? "Replay of a recorded run of the live demo (real Rhea + Ref code in a local NEAR sandbox). \"Crash\" replays what the agent did when NEAR fell to $1.75: three protective moves a few seconds apart, inside your rules and with no signature from you. Watch the ⚡ banner, the activity list and the Feed page. Run `pnpm demo:live` to do it for real (needs more memory)."
          : DEMO_TESTNET
            ? "Move the NEAR price the vault and Rhea read (our oracle on testnet; Rhea and Ref run their mainnet code). The agent, whose key is held in OutLayer's TEE, checks every 8 seconds. When the health factor drops below 1.3 it withdraws a little collateral, swaps it to USDC and repays, all inside your rules and with no signature from you. Every move is a public testnet transaction."
            : "Move the price the vault and Rhea read (the sandbox oracle). The agent checks every 3 seconds. When the health factor drops below 1.3 it withdraws a little collateral, swaps it to USDC and repays, all inside your rules and with no signature from you. Watch the activity list, the ⚡ banner and the Feed page."}
      </p>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.usd}
            type="button"
            title={p.hint}
            disabled={busy !== null}
            onClick={() => void setPrice(p.usd)}
            className={cn(btn, p.strong ? "bg-midnight-ink text-canvas-white ring-midnight-ink" : "text-midnight-ink ring-hairline hover:ring-midnight-ink/30")}
          >
            {busy === p.usd ? <Loader2 className="size-4 animate-spin" /> : <p.icon className="size-4" />} {p.label}
          </button>
        ))}
        <button type="button" disabled={busy !== null} onClick={() => void setPrice(start)} className={cn(btn, "text-midnight-ink ring-hairline hover:ring-midnight-ink/30")}>
          {busy === start ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Reset to ${start.toFixed(2)}
        </button>
      </div>
      {error && <p className="text-caption text-destructive">{error}</p>}
    </div>
  );
}

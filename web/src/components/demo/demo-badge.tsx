"use client";

// Small fixed badge on every page in demo mode, so nobody mistakes the sandbox for mainnet.
import { FlaskConical } from "lucide-react";
import { DEMO, DEMO_REPLAY, DEMO_TESTNET } from "@/lib/demo";
import { useDemoInfo } from "@/lib/near/use-near-account";

export function DemoBadge() {
  const info = useDemoInfo();
  if (!DEMO) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-midnight-ink/90 px-3.5 py-1.5 text-caption text-canvas-white shadow-card backdrop-blur-sm">
        <FlaskConical className="size-3.5 text-brand-orange" strokeWidth={2.4} />
        <span className="font-medium">Demo mode</span>
        <span className="hidden text-canvas-white/70 sm:inline">
          {DEMO_REPLAY && DEMO_TESTNET
            ? `replay of the recorded NEAR testnet run · tx links are real · nothing is signed here`
            : DEMO_REPLAY
            ? `replay of a recorded sandbox run · nothing is signed · as ${info.data?.accountId ?? "…"}`
            : DEMO_TESTNET
              ? `NEAR testnet · every action is a public transaction · signed in as ${info.data?.accountId ?? "…"}`
              : `local NEAR sandbox with real Rhea + Ref code · signed in as ${info.data?.accountId ?? "…"}`}
        </span>
        {info.isError && <span className="text-destructive">{DEMO_TESTNET ? "testnet runner not reachable" : "sandbox not reachable"}</span>}
      </div>
    </div>
  );
}

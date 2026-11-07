"use client";

// Demo mode only: explorer links land here, because the local sandbox isn't visible to nearblocks.
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { CinematicShell } from "@/components/parts/cinematic-shell";

function Body() {
  const q = useSearchParams();
  const tx = q.get("tx");
  const account = q.get("account");
  return (
    <div className="surface-card space-y-3 p-5 rounded-card">
      <h1 className="font-alt text-title font-medium tracking-tight text-midnight-ink">Local sandbox</h1>
      <p className="text-body-sm text-muted-ash">
        This demo runs on a local NEAR sandbox, so public explorers can&apos;t show it. On mainnet this link opens nearblocks.io.
      </p>
      {tx && (
        <div className="space-y-1">
          <div className="text-caption text-muted-ash">Transaction hash</div>
          <div className="break-all rounded-card bg-whisper-gray px-3 py-2 font-mono text-caption text-midnight-ink">{tx}</div>
        </div>
      )}
      {account && (
        <div className="space-y-1">
          <div className="text-caption text-muted-ash">Account</div>
          <div className="break-all rounded-card bg-whisper-gray px-3 py-2 font-mono text-caption text-midnight-ink">{account}</div>
        </div>
      )}
    </div>
  );
}

export default function DemoExplorer() {
  return (
    <CinematicShell mode="dim">
      <main className="mx-auto w-full max-w-xl px-4 pt-24 pb-10">
        <Suspense>
          <Body />
        </Suspense>
      </main>
    </CinematicShell>
  );
}

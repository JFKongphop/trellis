"use client";

// NEP-413 sign-in for server features (vault approvals, worker registration).
// One signMessage per session; the server verifies it and sets an httpOnly
// cookie (frontend-spec §3.1). near-frontend skill, wallet.md.

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNearWallet } from "near-connect-hooks";
import { signedFetch } from "@/lib/api-client";
import { DEMO } from "@/lib/demo";

export function useTrellisSession(accountId: string | null) {
  const { signNEP413Message } = useNearWallet();
  const qc = useQueryClient();
  const session = useQuery({
    queryKey: ["trellis-session"],
    queryFn: async () => {
      const r = await signedFetch("/api/auth/session", { cache: "no-store" });
      return ((await r.json()) as { accountId: string | null }).accountId;
    },
    staleTime: 60_000,
  });
  const signedIn = !!accountId && session.data === accountId;

  /** Make sure the server session belongs to the connected account (prompts the wallet once). */
  const ensure = useCallback(async (): Promise<void> => {
    if (!accountId) throw new Error("Connect a wallet first.");
    const current = await qc.fetchQuery({
      queryKey: ["trellis-session"],
      queryFn: async () => {
        const r = await signedFetch("/api/auth/session", { cache: "no-store" });
        return ((await r.json()) as { accountId: string | null }).accountId;
      },
      staleTime: 30_000,
    });
    if (current === accountId) return;
    if (DEMO) {
      // demo mode: no wallet to sign NEP-413; the server starts a session for the demo account
      const r = await signedFetch("/api/demo/session", { method: "POST" });
      const body = (await r.json()) as { accountId?: string; error?: string };
      if (!r.ok || !body.accountId) throw new Error(body.error ?? `Demo sign-in failed (${r.status})`);
      qc.setQueryData(["trellis-session"], body.accountId);
      return;
    }
    const n = (await (await signedFetch("/api/auth/nonce", { cache: "no-store" })).json()) as {
      nonce: string;
      message: string;
      recipient: string;
    };
    const nonce = Uint8Array.from(atob(n.nonce), (c) => c.charCodeAt(0));
    const signed = await signNEP413Message({ message: n.message, recipient: n.recipient, nonce });
    if (signed.accountId && signed.accountId !== accountId) {
      throw new Error(`The wallet signed as ${signed.accountId}, not ${accountId}.`);
    }
    const r = await signedFetch("/api/auth/near", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: signed.accountId || accountId,
        publicKey: signed.publicKey,
        signature: signed.signature,
        nonce: n.nonce,
        message: n.message,
        recipient: n.recipient,
      }),
    });
    const body = (await r.json()) as { accountId?: string; error?: string };
    if (!r.ok || !body.accountId) throw new Error(body.error ?? `Sign-in failed (${r.status})`);
    qc.setQueryData(["trellis-session"], body.accountId);
  }, [accountId, qc, signNEP413Message]);

  return { signedIn, sessionAccount: session.data ?? null, ensure };
}

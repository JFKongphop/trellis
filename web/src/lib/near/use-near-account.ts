"use client";

import { useQuery } from "@tanstack/react-query";
import { useNearWallet } from "near-connect-hooks";
import { NEAR_DECIMALS } from "@/lib/near/config";
import { readProvider } from "@/lib/near/rpc";
import { signedFetch } from "@/lib/api-client";
import { DEMO, DEMO_REPLAY, type DemoInfo } from "@/lib/demo";

/** Demo mode: the sandbox demo account + current demo NEAR price (refreshed every 5 s). */
export function useDemoInfo() {
  return useQuery({
    queryKey: ["demo-info"],
    enabled: DEMO,
    refetchInterval: 5_000,
    queryFn: async () => {
      const r = await signedFetch("/api/demo/info", { cache: "no-store" });
      const j = (await r.json()) as DemoInfo & { error?: string };
      if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
      return j;
    },
  });
}

/** Connected NEAR account id ("" → null) + wallet actions. In demo mode: the demo account. */
export function useNearAccount() {
  const w = useNearWallet();
  const demo = useDemoInfo();
  if (DEMO) {
    const noop = async () => {};
    return {
      accountId: demo.data?.accountId ?? null,
      loading: demo.isPending,
      signIn: noop as unknown as typeof w.signIn,
      signOut: noop as unknown as typeof w.signOut,
      wallet: w,
    };
  }
  return {
    accountId: w.signedAccountId || null,
    loading: w.loading,
    signIn: w.signIn,
    signOut: w.signOut,
    wallet: w,
  };
}

/** Native NEAR balance (total, in NEAR) of an account, refreshed every 30s. */
export function useNearBalance(accountId: string | null) {
  const { getBalance } = useNearWallet();
  const demo = useDemoInfo();
  return useQuery({
    queryKey: ["near-balance", accountId, DEMO_REPLAY ? demo.data?.nearBalance : null],
    enabled: !!accountId && (!DEMO_REPLAY || demo.data?.nearBalance !== undefined),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (DEMO_REPLAY) return demo.data!.nearBalance!; // replay: no chain to read
      const raw = DEMO
        ? (await readProvider().viewAccount({ accountId: accountId! })).amount
        : await getBalance(accountId!);
      const yocto = BigInt(raw);
      const d = BigInt(10) ** BigInt(NEAR_DECIMALS);
      return Number(yocto / d) + Number(yocto % d) / 10 ** NEAR_DECIMALS;
    },
  });
}

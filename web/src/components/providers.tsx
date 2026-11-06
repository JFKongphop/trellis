"use client";

// Client-only provider wrapper. near-connect-hooks ships no "use client"
// directive and defaults to TESTNET, so this module (a client boundary) mounts
// it with the network set explicitly from NEXT_PUBLIC_NEAR_NETWORK. The
// connector itself is SSR-safe (verified: renderToString works and only the
// browser opens wallets).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NearProvider } from "near-connect-hooks";
import { useState, type ComponentProps, type ReactNode } from "react";
import { NEAR_NETWORK, PUBLIC_RPC_URLS } from "@/lib/near/config";

// Module-level (stable identity): NearProvider memoizes its RPC provider on
// `config.providers` and the connector on `network`.
const NEAR_CONFIG: ComponentProps<typeof NearProvider>["config"] = {
  network: NEAR_NETWORK,
  providers:
    NEAR_NETWORK === "mainnet"
      ? { mainnet: PUBLIC_RPC_URLS }
      : { testnet: PUBLIC_RPC_URLS },
  footerBranding: {
    heading: "Trellis",
    link: "https://near.org",
    linkText: "What is NEAR?",
  },
};

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <NearProvider config={NEAR_CONFIG}>{children}</NearProvider>
    </QueryClientProvider>
  );
}

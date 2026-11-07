"use client";

// Browser-side fetchers for our NEAR read routes (/api/*, signed by the
// session proxy). Types are shared with the server readers.

import { useQuery } from "@tanstack/react-query";
import { signedFetch } from "@/lib/api-client";
import type { AccountBalances } from "@/lib/near/balances";
import type { LendingMarket, LendingPosition } from "@/lib/near/burrow";
import type { TokenSearchHit } from "@/lib/near/tokens";
import type { VaultPolicy, VaultReceipt, VaultStatus, VaultTokenInfo } from "@/lib/near/vault";
import type { FeedResponse } from "@/lib/feed";
import { DEMO } from "@/lib/demo";
import type { IntentsQuote, IntentsStatus } from "@/lib/oneclick/assets";

export type { AccountBalances, TokenBalance } from "@/lib/near/balances";
export type { LendingMarket, LendingPosition, PositionLine } from "@/lib/near/burrow";
export type { TokenSearchHit } from "@/lib/near/tokens";

export type PriceRow = {
  tokenId: string;
  symbol?: string;
  priceUsd?: number;
  verified: boolean;
};

async function getJson<T>(path: string): Promise<T> {
  const r = await signedFetch(path, { cache: "no-store" });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok || (body as { error?: string }).error) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  }
  return body;
}

const enc = encodeURIComponent;

export const fetchBalances = (accountId: string) =>
  getJson<AccountBalances>(`/api/balances?account=${enc(accountId)}`);

export const fetchPosition = (accountId: string) =>
  getJson<LendingPosition>(`/api/positions?account=${enc(accountId)}`);

export const fetchMarkets = () =>
  getJson<{ markets: LendingMarket[] }>(`/api/markets`).then((r) => r.markets);

export const fetchPrices = (ids: string[]) =>
  getJson<{ prices: PriceRow[] }>(`/api/prices?ids=${enc(ids.join(","))}`).then(
    (r) => r.prices,
  );

export const fetchTokenSearch = (q: string) =>
  getJson<{ results: TokenSearchHit[] }>(`/api/tokens/search?q=${enc(q)}`).then(
    (r) => r.results,
  );

// Icons are display-only and never sent to the model (pruneForModel strips
// icon fields), so cards resolve them from this client-side map.
const tokenIcons = new Map<string, string>();
export function rememberIcons(rows: { tokenId?: string; id?: string; icon?: string }[]) {
  for (const r of rows) {
    const id = r.tokenId ?? r.id;
    if (id && r.icon) tokenIcons.set(id, r.icon);
  }
}
export const iconFor = (tokenId: string) => tokenIcons.get(tokenId);

export function useLendingMarkets() {
  return useQuery({
    queryKey: ["lending-markets"],
    queryFn: fetchMarkets,
    staleTime: 30_000,
  });
}

export function useBalances(accountId: string | null) {
  return useQuery({
    queryKey: ["balances", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const b = await fetchBalances(accountId!);
      rememberIcons(b.balances);
      return b;
    },
    staleTime: 15_000,
  });
}

export function useLendingPosition(accountId: string | null) {
  return useQuery({
    queryKey: ["lending-position", accountId],
    enabled: !!accountId,
    queryFn: () => fetchPosition(accountId!),
    staleTime: 15_000,
  });
}

// ── Vault (pass 2) ────────────────────────────────────────────────────────

export type VaultOwnerInfo = {
  owner: string;
  vaultId: string | null;
  predictedId: string;
  minDeposit: string;
  factory: string;
  agent: string;
};

export type VaultState = {
  vaultId: string;
  status: VaultStatus;
  policy: VaultPolicy | null;
  tokens: [string, VaultTokenInfo][];
  receipts: VaultReceipt[];
  remaining: Record<string, string>;
  balances: AccountBalances;
  position: LendingPosition;
  protocolsReady: boolean;
};

export const fetchVaultOwner = (account: string) =>
  getJson<VaultOwnerInfo>(`/api/vault/owner?account=${enc(account)}`);
export const fetchVaultState = (vaultId: string) =>
  getJson<VaultState>(`/api/vault/state?id=${enc(vaultId)}`);

export function useVaultOf(accountId: string | null) {
  return useQuery({
    queryKey: ["vault-of", accountId],
    enabled: !!accountId,
    queryFn: () => fetchVaultOwner(accountId!),
    staleTime: 15_000,
  });
}

export function useVaultState(vaultId: string | null | undefined) {
  return useQuery({
    queryKey: ["vault-state", vaultId],
    enabled: !!vaultId,
    queryFn: async () => {
      const s = await fetchVaultState(vaultId!);
      rememberIcons(s.balances.balances);
      return s;
    },
    // demo mode: refresh fast so the agent's moves show up one by one
    refetchInterval: DEMO ? 3_000 : 15_000,
  });
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await signedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok || (j as { error?: string }).error) {
    throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  }
  return j;
}

/** Public agent feed (/feed); refreshes every 15 s. */
export function useFeed() {
  return useQuery({
    queryKey: ["feed"],
    queryFn: () => getJson<FeedResponse>("/api/feed"),
    refetchInterval: 15_000,
  });
}

// ── Cross-chain funding (NEAR Intents 1Click) ─────────────────────────────

export class QuoteError extends Error {
  constructor(message: string, readonly code?: string, readonly token?: string) {
    super(message);
  }
}

export type QuoteInput = {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  recipient: string;
  dry: boolean;
};

export async function fetchIntentsQuote(input: QuoteInput): Promise<IntentsQuote> {
  const r = await signedFetch("/api/intents/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = (await r.json().catch(() => ({}))) as IntentsQuote & { error?: string; code?: string; token?: string };
  if (!r.ok || j.error) throw new QuoteError(j.error ?? `HTTP ${r.status}`, j.code, j.token);
  return j;
}

export const fetchIntentsStatus = (depositAddress: string, depositMemo?: string) =>
  getJson<IntentsStatus>(
    `/api/intents/status?depositAddress=${enc(depositAddress)}${depositMemo ? `&depositMemo=${enc(depositMemo)}` : ""}`,
  );

export const submitIntentsDeposit = (txHash: string, depositAddress: string) =>
  postJson<{ ok: boolean }>("/api/intents/submit", { txHash, depositAddress });

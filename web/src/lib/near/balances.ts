import "server-only";

// Wallet balances for any NEAR account: native NEAR (available = total −
// storage-locked) + every fungible token FastNEAR has indexed for it.
// FastNEAR REST shape verified live (near-frontend skill, gasless-and-data.md):
//   GET /v1/account/{id}/full → { state: { balance, locked, storage_bytes }, tokens: [{ contract_id, balance }] }
// Indexed balances can lag the chain head slightly; for the well-known tokens
// we re-read `ft_balance_of` via RPC so the numbers the agent plans with are
// current (amounts that gate money are re-checked again at plan build time).

import { readProvider, view } from "@/lib/near/rpc";
import {
  FASTNEAR_API,
  NATIVE_NEAR_ID,
  NEAR_DECIMALS,
  STORAGE_YOCTO_PER_BYTE,
  TOKENS,
  WRAP_NEAR,
} from "@/lib/near/config";
import { tokenMetas, pricesUsd } from "@/lib/near/tokens";

export type TokenBalance = {
  tokenId: string;
  symbol: string;
  name?: string;
  decimals: number;
  /** Human units. */
  balance: number;
  /** Base units (string). */
  balanceRaw: string;
  priceUsd?: number;
  valueUsd?: number;
  /** Ref-whitelisted or well-known id. Unverified tokens may be spam. */
  verified: boolean;
  icon?: string;
};

export type AccountBalances = {
  accountId: string;
  exists: boolean;
  balances: TokenBalance[];
  totalUsd: number;
  /** NEAR locked for storage (not spendable). */
  storageLockedNear?: number;
};

type FastNearFull = {
  account_id: string;
  state?: { balance: string; locked: string; storage_bytes: number } | null;
  tokens?: { contract_id: string; balance: string }[];
};

function toHuman(raw: string, decimals: number): number {
  const b = BigInt(raw);
  const d = BigInt(10) ** BigInt(decimals);
  return Number(b / d) + Number(b % d) / 10 ** decimals;
}

async function fastnearFull(accountId: string): Promise<FastNearFull | null> {
  const headers: Record<string, string> = {};
  if (process.env.FASTNEAR_API_KEY) {
    headers.Authorization = `Bearer ${process.env.FASTNEAR_API_KEY}`;
  }
  const r = await fetch(
    `${FASTNEAR_API}/v1/account/${encodeURIComponent(accountId)}/full`,
    { headers, cache: "no-store" },
  );
  if (!r.ok) return null;
  return (await r.json()) as FastNearFull;
}

export async function readBalances(accountId: string): Promise<AccountBalances> {
  // Native NEAR from RPC (authoritative); FastNEAR for the token list.
  let nearTotal = BigInt(0);
  let storageBytes = 0;
  try {
    const acct = await readProvider().viewAccount({
      accountId,
      blockQuery: { finality: "final" },
    });
    nearTotal = BigInt(acct.amount);
    storageBytes = Number(acct.storage_usage ?? 0);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/does not exist|AccountDoesNotExist/i.test(msg) || (e as Error)?.name === "AccountDoesNotExistError") {
      return { accountId, exists: false, balances: [], totalUsd: 0 };
    }
    throw e;
  }

  const fast = await fastnearFull(accountId).catch(() => null);
  const ftRows = new Map<string, string>();
  for (const t of fast?.tokens ?? []) {
    if (t.balance && t.balance !== "0") ftRows.set(t.contract_id, t.balance);
  }
  // Refresh well-known tokens from RPC (covers FastNEAR lag / missing rows).
  await Promise.all(
    Object.values(TOKENS).map(async (id) => {
      const b = await view<string>(id, "ft_balance_of", { account_id: accountId }).catch(
        () => null,
      );
      if (typeof b === "string") {
        if (b === "0") ftRows.delete(id);
        else ftRows.set(id, b);
      }
    }),
  );

  const ids = [...ftRows.keys()];
  const [metas, prices] = await Promise.all([
    tokenMetas([...ids, WRAP_NEAR]),
    pricesUsd([...ids, WRAP_NEAR]).catch(() => ({}) as Record<string, number>),
  ]);

  const balances: TokenBalance[] = [];
  const storageLocked = BigInt(storageBytes) * STORAGE_YOCTO_PER_BYTE;
  const available = nearTotal > storageLocked ? nearTotal - storageLocked : BigInt(0);
  const nearPrice = prices[WRAP_NEAR];
  const nearHuman = toHuman(available.toString(), NEAR_DECIMALS);
  balances.push({
    tokenId: NATIVE_NEAR_ID,
    symbol: "NEAR",
    name: "NEAR (native)",
    decimals: NEAR_DECIMALS,
    balance: nearHuman,
    balanceRaw: available.toString(),
    priceUsd: nearPrice,
    valueUsd: nearPrice !== undefined ? nearHuman * nearPrice : undefined,
    verified: true,
  });

  for (const [id, raw] of ftRows) {
    const m = metas.get(id);
    if (!m) continue; // no metadata → not a usable FT
    const human = toHuman(raw, m.decimals);
    const price = prices[id];
    balances.push({
      tokenId: id,
      symbol: m.symbol,
      name: m.name,
      decimals: m.decimals,
      balance: human,
      balanceRaw: raw,
      priceUsd: price,
      valueUsd: price !== undefined ? human * price : undefined,
      verified: m.verified,
      icon: m.icon,
    });
  }

  balances.sort((a, b) => {
    if (a.tokenId === NATIVE_NEAR_ID) return -1;
    if (b.tokenId === NATIVE_NEAR_ID) return 1;
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return (b.valueUsd ?? 0) - (a.valueUsd ?? 0) || b.balance - a.balance;
  });

  return {
    accountId,
    exists: true,
    balances,
    totalUsd: balances.reduce(
      (s, b) => s + (b.verified && b.valueUsd ? b.valueUsd : 0),
      0,
    ),
    storageLockedNear: toHuman(storageLocked.toString(), NEAR_DECIMALS),
  };
}

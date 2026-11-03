// Reads everything the worker needs about one vault, from the same sources the vault uses.
import { view } from "./near.ts";
import { healthFactorBps, parsePrice, usdValue, checkPrice, type Leg, type Price } from "./health.ts";

export type TokenInfo = { decimals: number; burrow_extra_decimals: number; price_id: string; volatility_ratio_bps: number };
export type Policy = {
  allowed_tokens: string[];
  allowed_ref_pools: number[];
  per_action_cap: [string, string][];
  daily_cap: [string, string][];
  max_slippage_bps: number;
  max_intents_spread_bps: number;
  min_health_factor_bps: number;
  deleverage_trigger_bps: number;
  emergency_floor_bps: number;
  max_price_age_sec: number;
  max_price_conf_bps: number;
  burrow_enabled: boolean;
  ref_enabled: boolean;
  intents_enabled: boolean;
};
export type PendingOp = { op_id: string; kind: string; state: "Started" | "Submitted"; submitted_at?: string | null };
/** Open deleverage cycle: the vault only allows swapping `collateral_token` and repaying until it closes. */
export type PendingDeleverage = {
  collateral_token: string;
  collateral_left: string;
  debt_token: string | null;
  repay_due: string;
  started_at: string;
};
export type Status = {
  owner: string;
  agent: string | null;
  paused: boolean;
  in_flight: PendingOp | null;
  pending_deleverage?: PendingDeleverage | null;
};
export type Protocols = { burrow: string; ref_exchange: string; oracle: string; intents: string; wrap: string };
export type PosEntry = { token_id: string; balance: bigint };

export type Snapshot = {
  vaultId: string;
  status: Status;
  policy: Policy;
  protocols: Protocols;
  tokens: Map<string, TokenInfo>;
  prices: Map<string, Price>;
  priceError: string | null;
  collateral: PosEntry[];
  borrowed: PosEntry[];
  /** Vault wallet balances (token base units). */
  balances: Map<string, bigint>;
  remainingDaily: Map<string, bigint>;
  hfBps: bigint | null;
  collateralLegs: Leg[];
  debtLegs: Leg[];
};

const protocolCache = new Map<string, Protocols>();

function entries(list: any): PosEntry[] {
  if (!Array.isArray(list)) return [];
  return list.map((e) => ({ token_id: String(e.token_id), balance: BigInt(e.balance) }));
}

export async function readSnapshot(vaultId: string): Promise<Snapshot> {
  let protocols = protocolCache.get(vaultId);
  if (!protocols) {
    protocols = await view<Protocols>(vaultId, "get_protocols");
    protocolCache.set(vaultId, protocols);
  }
  const [status, policy, tokenList, pos] = await Promise.all([
    view<Status>(vaultId, "get_status"),
    view<Policy>(vaultId, "get_policy"),
    view<[string, TokenInfo][]>(vaultId, "get_tokens"),
    view<any>(protocols.burrow, "get_account_all_positions", { account_id: vaultId }),
  ]);
  const tokens = new Map(tokenList);
  const ids = [...tokens.keys()];
  const [rawPrices, rawBalances, rawRemaining] = await Promise.all([
    Promise.all(ids.map((t) => view<any>(protocols!.oracle, "get_price_no_older_than", { price_id: tokens.get(t)!.price_id, age: policy.max_price_age_sec }).catch(() => null))),
    Promise.all(ids.map((t) => view<string>(t, "ft_balance_of", { account_id: vaultId }).catch(() => "0"))),
    Promise.all(ids.map((t) => view<string>(vaultId, "remaining_daily", { token: t }).catch(() => "0"))),
  ]);
  const nowSec = Math.floor(Date.now() / 1000);
  const prices = new Map<string, Price>();
  let priceError: string | null = null;
  ids.forEach((t, i) => {
    const p = parsePrice(rawPrices[i]);
    const err = p ? checkPrice(p, nowSec, policy.max_price_age_sec, policy.max_price_conf_bps) : "price_missing";
    if (p && !err) prices.set(t, p);
    else priceError ??= `${t}: ${err}`;
  });
  const balances = new Map(ids.map((t, i) => [t, BigInt(rawBalances[i] ?? "0")] as const));
  const remainingDaily = new Map(ids.map((t, i) => [t, BigInt(rawRemaining[i] ?? "0")] as const));

  const regular = pos?.positions?.REGULAR ?? {};
  const collateral = entries(regular.collateral);
  const borrowed = entries(regular.borrowed);
  const leg = (e: PosEntry): Leg | null => {
    const info = tokens.get(e.token_id);
    const p = prices.get(e.token_id);
    if (!info || !p) return null;
    return { valueUsd: usdValue(e.balance, info.decimals + info.burrow_extra_decimals, p), volatilityRatioBps: info.volatility_ratio_bps };
  };
  const collateralLegs = collateral.map(leg);
  const debtLegs = borrowed.map(leg);
  const complete = collateralLegs.every(Boolean) && debtLegs.every(Boolean);
  const hfBps = complete && borrowed.length > 0 ? healthFactorBps(collateralLegs as Leg[], debtLegs as Leg[]) : null;
  return {
    vaultId,
    status,
    policy,
    protocols,
    tokens,
    prices,
    priceError,
    collateral,
    borrowed,
    balances,
    remainingDaily,
    hfBps,
    collateralLegs: collateralLegs.filter(Boolean) as Leg[],
    debtLegs: debtLegs.filter(Boolean) as Leg[],
  };
}

/** Allowlisted Ref pool whose pair is exactly {a, b} (pool → pair cached). */
const poolPairs = new Map<string, string[]>();
export async function findPool(snap: Snapshot, a: string, b: string): Promise<number | null> {
  for (const id of snap.policy.allowed_ref_pools) {
    const key = `${snap.protocols.ref_exchange}:${id}`;
    let pair = poolPairs.get(key);
    if (!pair) {
      const pool = await view<any>(snap.protocols.ref_exchange, "get_pool", { pool_id: id }).catch(() => null);
      pair = (pool?.token_account_ids ?? []) as string[];
      poolPairs.set(key, pair);
    }
    if (pair.length === 2 && pair.includes(a) && pair.includes(b)) return id;
  }
  return null;
}

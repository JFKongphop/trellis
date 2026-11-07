import "server-only";

// Rhea Lending (Burrow) reads: account position + health factor, and markets.
// Follows the rhea-burrow-lending skill (views-and-health.md §1–5,
// strategies.md §7 TS reader, verified there against mainnet):
//   HF = Σ coll_usd · vol_c  /  Σ debt_usd / vol_d     (vol = volatility_ratio / 10000)
// Collateral rounds down, debt rounds up (same direction as Burrow).
// Prices come from aggregate-oracle.near (the oracle Burrow uses), not Ref.

import { view } from "@/lib/near/rpc";
import { BURROW, ORACLE } from "@/lib/near/config";
import { tokenMetas, pricesUsd } from "@/lib/near/tokens";

type AssetView = { token_id: string; balance: string; shares: string; apr: string };
type BurrowAccount = {
  account_id: string;
  supplied: AssetView[];
  positions?: Record<string, { collateral: AssetView[]; borrowed: AssetView[] }>;
  is_locked?: boolean;
};
type PythInfo = {
  decimals: number;
  fraction_digits: number;
  price_identifier: string;
  extra_call: string | null;
  default_price: { multiplier: string; decimals: number } | null;
};
type PythPrice = { price: string; conf: string; expo: number; publish_time: number };
type AssetConfig = {
  volatility_ratio: number;
  extra_decimals: number;
  can_deposit: boolean;
  can_withdraw: boolean;
  can_use_as_collateral: boolean;
  can_borrow: boolean;
  supplied_limit?: string;
  borrowed_limit?: string;
};
type AssetDetailed = {
  token_id: string;
  supplied: { shares: string; balance: string };
  borrowed: { shares: string; balance: string };
  reserved: string;
  prot_fee?: string;
  margin_debt?: { balance: string };
  margin_pending_debt?: string;
  config: AssetConfig;
  supply_apr: string;
  borrow_apr: string;
};
type BurrowConfig = {
  pyth_price_valid_duration_sec: number;
  contract_mode?: string;
};

const PRICE_MAX_AGE_SEC = 60; // = Burrow's pyth_price_valid_duration_sec
const BPS = BigInt(10000);
const E18 = BigInt(10) ** BigInt(18);
const pow10 = (n: number) => BigInt(10) ** BigInt(n);

/** bigint scaled by 1e18 → JS number (display only). */
const e18ToNum = (x: bigint) => Number(x / BigInt(1e9)) / 1e9;

/** inner-unit balance → human number (display only). */
function innerToHuman(balance: string, decimals: number, extra: number): number {
  const d = decimals + extra;
  const b = BigInt(balance);
  const whole = b / pow10(d);
  const frac = b % pow10(d);
  return Number(whole) + Number(frac) / 10 ** d;
}

export type PositionLine = {
  tokenId: string;
  symbol: string;
  amount: number;
  valueUsd?: number;
  /** APR as a percent (Burrow's `apr`), e.g. 32.6. */
  aprPct: number;
  /** Collateral factor (volatility_ratio) as a percent, e.g. 75. */
  collateralFactorPct?: number;
};

export type LendingPosition = {
  accountId: string;
  registered: boolean;
  collateral: PositionLine[];
  borrowed: PositionLine[];
  /** Deposited but not used as collateral (doesn't count for HF). */
  supplied: PositionLine[];
  /** null when there is no debt (HF is infinite). */
  healthFactor: number | null;
  /** Risk-adjusted sums used for HF (USD). */
  adjustedCollateralUsd?: number;
  adjustedDebtUsd?: number;
  totalCollateralUsd?: number;
  totalDebtUsd?: number;
  netValueUsd?: number;
  /** Price of each collateral token at which HF hits 1.0 (others held constant). */
  liquidationPrices: { tokenId: string; symbol: string; currentPriceUsd: number; liquidationPriceUsd: number; dropPct: number }[];
  /** Borrowed USD / collateral USD (raw, no factors), as a percent. */
  loanToValuePct?: number;
  pricesFresh: boolean;
  notes: string[];
  contractMode?: string;
  isLocked?: boolean;
};

type PriceOut = { mult: bigint; dec: number; usd: number; fresh: boolean };

async function loadPrices(
  tokens: string[],
  infos: Record<string, PythInfo>,
  maxAge: number,
): Promise<{ priceOf: (t: string) => PriceOut | null; fresh: boolean }> {
  const ids = [
    ...new Set(
      tokens
        .filter((t) => infos[t] && !infos[t].default_price)
        .map((t) => infos[t].price_identifier),
    ),
  ];
  const fresh = ids.length
    ? ((await view<Record<string, PythPrice | null>>(ORACLE, "list_prices_no_older_than", {
        price_ids: ids,
        age: maxAge,
      })) ?? {})
    : {};
  // LSTs (stNEAR, LiNEAR, NEARX, rNEAR, xRHEA): Burrow multiplies the base
  // oracle price by the token's own rate view (`extra_call`). All five live
  // rate views return a U128 scaled by 1e24 (probed 2026-10-22).
  // TODO(verify): exact rounding order in burrowland pyth.rs for extra_call.
  const rates: Record<string, bigint> = {};
  await Promise.all(
    tokens
      .filter((t) => infos[t]?.extra_call)
      .map(async (t) => {
        const rate = await view<string>(t, infos[t].extra_call!).catch(() => null);
        if (typeof rate === "string" && /^\d+$/.test(rate)) rates[t] = BigInt(rate);
      }),
  );
  // Display fallback only: if a fresh price is missing, read the latest one
  // (no age filter) and flag it. The vault contract never does this; it fails
  // closed (trellis-vault rule 6).
  const stale: Record<string, PythPrice | null> = {};
  for (const id of ids) {
    if (!fresh[id]) {
      stale[id] = await view<PythPrice>(ORACLE, "get_price", { price_identifier: id }).catch(
        () => null,
      );
    }
  }
  let allFresh = true;
  const priceOf = (t: string): PriceOut | null => {
    const info = infos[t];
    if (!info) return null;
    if (info.default_price) {
      const mult = BigInt(info.default_price.multiplier);
      const dec = info.default_price.decimals;
      return { mult, dec, usd: Number(mult) / 10 ** (dec - info.decimals), fresh: true };
    }
    let rate: bigint | null = null;
    if (info.extra_call) {
      rate = rates[t] ?? null;
      if (rate === null) return null; // rate view failed: no price
    }
    const p = fresh[info.price_identifier] ?? stale[info.price_identifier];
    if (!p) return null;
    const isFresh = !!fresh[info.price_identifier];
    if (!isFresh) allFresh = false;
    const price = BigInt(p.price);
    const fd = pow10(info.fraction_digits);
    // BL:pyth.rs:216-229 — multiplier = floor(price · 10^expo · 10^fraction_digits)
    let mult = p.expo < 0 ? (price * fd) / pow10(-p.expo) : price * pow10(p.expo) * fd;
    let usd = Number(p.price) * 10 ** p.expo;
    if (rate !== null) {
      mult = (mult * rate) / pow10(24);
      usd = (usd * Number(rate / BigInt(1e12))) / 1e12;
    }
    return { mult, dec: info.decimals + info.fraction_digits, usd, fresh: isFresh };
  };
  return {
    priceOf,
    get fresh() {
      return allFresh;
    },
  };
}

/** Burrow position + health factor for an account. */
export async function readLendingPosition(accountId: string): Promise<LendingPosition> {
  // One RPC call: [account, margin, assets, config, margin_config, -, -, pyth_infos]
  // (BL:lib.rs:307, verified live in the skill).
  const batch = await view<unknown[]>(BURROW, "batch_views", {
    account_id: accountId,
    assets: false,
    config: true,
    margin_config: false,
    default_margin_base_token_limit: false,
    margin_base_token_limit: false,
    token_pyth_infos: true,
  });
  if (!batch) throw new Error("Rhea Lending batch_views returned nothing");
  const acct = batch[0] as BurrowAccount | null;
  const cfg = batch[3] as BurrowConfig;
  const infos = batch[7] as Record<string, PythInfo>;

  const empty: LendingPosition = {
    accountId,
    registered: !!acct,
    collateral: [],
    borrowed: [],
    supplied: [],
    healthFactor: null,
    liquidationPrices: [],
    pricesFresh: true,
    notes: [],
    contractMode: cfg?.contract_mode,
  };
  if (!acct) return empty;

  const reg = acct.positions?.REGULAR ?? { collateral: [], borrowed: [] };
  const tokens = [
    ...new Set([...reg.collateral, ...reg.borrowed, ...acct.supplied].map((a) => a.token_id)),
  ];
  if (tokens.length === 0) return { ...empty, isLocked: acct.is_locked };

  const [assets, metas, refUsd] = await Promise.all([
    view<{ token_id: string; config: AssetConfig }[]>(BURROW, "get_assets", { token_ids: tokens }),
    tokenMetas(tokens),
    pricesUsd(tokens).catch(() => ({}) as Record<string, number>),
  ]);
  const cfgOf = Object.fromEntries((assets ?? []).map((a) => [a.token_id, a.config]));
  const prices = await loadPrices(
    tokens,
    infos,
    cfg?.pyth_price_valid_duration_sec ?? PRICE_MAX_AGE_SEC,
  );
  const notes: string[] = [];

  const decimalsOf = (t: string) => infos[t]?.decimals ?? metas.get(t)?.decimals ?? 0;
  const symbolOf = (t: string) => metas.get(t)?.symbol ?? t;

  // USD value (scaled 1e18) exactly as Burrow: balance · mult / 10^(dec + extra)
  const usdE18 = (bal: string, t: string): bigint | null => {
    const p = prices.priceOf(t);
    const c = cfgOf[t];
    if (!p || !c) return null;
    return (BigInt(bal) * p.mult * E18) / pow10(p.dec + c.extra_decimals);
  };

  const line = (a: AssetView, withFactor: boolean): PositionLine => {
    const c = cfgOf[a.token_id];
    const v = usdE18(a.balance, a.token_id);
    let valueUsd: number | undefined = v != null ? e18ToNum(v) : undefined;
    if (valueUsd === undefined && refUsd[a.token_id] !== undefined && c) {
      valueUsd = innerToHuman(a.balance, decimalsOf(a.token_id), c.extra_decimals) * refUsd[a.token_id];
    }
    return {
      tokenId: a.token_id,
      symbol: symbolOf(a.token_id),
      amount: c ? innerToHuman(a.balance, decimalsOf(a.token_id), c.extra_decimals) : 0,
      valueUsd,
      aprPct: Number(a.apr) * 100,
      collateralFactorPct: withFactor && c ? c.volatility_ratio / 100 : undefined,
    };
  };

  const collateral = reg.collateral.map((a) => line(a, true));
  const borrowed = reg.borrowed.map((a) => line(a, true));
  const supplied = acct.supplied.map((a) => line(a, false));

  // Health factor (fails closed to null + note if any price is missing).
  let adjC = BigInt(0);
  let adjD = BigInt(0);
  let rawC = BigInt(0);
  let rawD = BigInt(0);
  const perTokenC = new Map<string, bigint>();
  const perTokenD = new Map<string, bigint>();
  let hfOk = true;
  for (const a of reg.collateral) {
    const v = usdE18(a.balance, a.token_id);
    const c = cfgOf[a.token_id];
    if (v == null || !c) {
      hfOk = false;
      notes.push(`No oracle price for collateral ${symbolOf(a.token_id)}; health factor not computed.`);
      continue;
    }
    const adj = (v * BigInt(c.volatility_ratio)) / BPS;
    adjC += adj;
    rawC += v;
    perTokenC.set(a.token_id, (perTokenC.get(a.token_id) ?? BigInt(0)) + adj);
  }
  for (const a of reg.borrowed) {
    const v = usdE18(a.balance, a.token_id);
    const c = cfgOf[a.token_id];
    if (v == null || !c || c.volatility_ratio === 0) {
      hfOk = false;
      notes.push(`No oracle price for debt ${symbolOf(a.token_id)}; health factor not computed.`);
      continue;
    }
    const r = BigInt(c.volatility_ratio);
    const adj = (v * BPS + r - BigInt(1)) / r; // round debt up
    adjD += adj;
    rawD += v;
    perTokenD.set(a.token_id, (perTokenD.get(a.token_id) ?? BigInt(0)) + adj);
  }

  let healthFactor: number | null = null;
  const liquidationPrices: LendingPosition["liquidationPrices"] = [];
  if (hfOk && reg.borrowed.length > 0 && adjD > BigInt(0)) {
    healthFactor = Number((adjC * BPS) / adjD) / 10000;
    // Liquidation price for collateral token T (all other prices fixed).
    // NOTE: NEAR-correlated tokens (wNEAR + LSTs) move together in reality;
    // this per-token view is conservative only for single-collateral positions.
    // HF(k) = (cT·k + cO) / (dT·k + dO) = 1  ⇒  k = (dO − cO) / (cT − dT)
    for (const [t, cT] of perTokenC) {
      const dT = perTokenD.get(t) ?? BigInt(0);
      const cO = adjC - cT;
      const dO = adjD - dT;
      if (cT <= dT) continue;
      const k = e18ToNum(dO - cO) / e18ToNum(cT - dT);
      const p = prices.priceOf(t);
      if (!p || !(k > 0) || !Number.isFinite(k)) continue;
      liquidationPrices.push({
        tokenId: t,
        symbol: symbolOf(t),
        currentPriceUsd: p.usd,
        liquidationPriceUsd: p.usd * k,
        dropPct: (1 - k) * 100,
      });
    }
  }
  if (reg.borrowed.length === 0 && reg.collateral.length > 0) {
    notes.push("No debt, so the position cannot be liquidated.");
  }
  if (!prices.fresh) {
    notes.push("Some oracle prices were older than 60 seconds; numbers are approximate.");
  }
  if (cfg?.contract_mode && cfg.contract_mode !== "Running") {
    notes.push(`Rhea Lending contract mode is "${cfg.contract_mode}" (not Running).`);
  }

  const totalCollateralUsd = hfOk ? e18ToNum(rawC) : undefined;
  const totalDebtUsd = hfOk ? e18ToNum(rawD) : undefined;
  const suppliedUsd = supplied.reduce((s, l) => s + (l.valueUsd ?? 0), 0);
  return {
    accountId,
    registered: true,
    collateral,
    borrowed,
    supplied,
    healthFactor,
    adjustedCollateralUsd: hfOk ? e18ToNum(adjC) : undefined,
    adjustedDebtUsd: hfOk ? e18ToNum(adjD) : undefined,
    totalCollateralUsd,
    totalDebtUsd,
    netValueUsd:
      totalCollateralUsd !== undefined && totalDebtUsd !== undefined
        ? totalCollateralUsd - totalDebtUsd + suppliedUsd
        : undefined,
    liquidationPrices,
    loanToValuePct:
      totalCollateralUsd && totalDebtUsd !== undefined && totalCollateralUsd > 0
        ? (totalDebtUsd / totalCollateralUsd) * 100
        : undefined,
    pricesFresh: prices.fresh,
    notes,
    contractMode: cfg?.contract_mode,
    isLocked: acct.is_locked,
  };
}

export type LendingMarket = {
  tokenId: string;
  symbol: string;
  supplyAprPct: number;
  borrowAprPct: number;
  utilizationPct: number;
  totalSupplied: number;
  totalBorrowed: number;
  /** Amount that can still be borrowed or withdrawn right now. */
  availableLiquidity: number;
  totalSuppliedUsd?: number;
  availableLiquidityUsd?: number;
  priceUsd?: number;
  collateralFactorPct: number;
  canBorrow: boolean;
  canUseAsCollateral: boolean;
  canDeposit: boolean;
  verified: boolean;
};

/** All Rhea Lending markets that accept deposits or borrows. */
export async function readLendingMarkets(): Promise<LendingMarket[]> {
  // get_assets_paged_detailed iterates from_index..min(len, limit) (paging bug
  // noted in the skill), so one call with from_index 0 + a large limit returns
  // every asset (25 live on 2026-10-22).
  const [assets, infos] = await Promise.all([
    view<AssetDetailed[]>(BURROW, "get_assets_paged_detailed", { from_index: 0, limit: 100 }),
    view<Record<string, PythInfo>>(BURROW, "get_all_token_pyth_infos"),
  ]);
  const list = (assets ?? []).filter(
    (a) =>
      (a.config.can_deposit || a.config.can_borrow) && !a.token_id.startsWith("shadow_"),
  );
  const ids = list.map((a) => a.token_id);
  const [metas, usd] = await Promise.all([
    tokenMetas(ids),
    pricesUsd(ids).catch(() => ({}) as Record<string, number>),
  ]);
  const out: LendingMarket[] = [];
  for (const a of list) {
    const meta = metas.get(a.token_id);
    const decimals = infos?.[a.token_id]?.decimals ?? meta?.decimals;
    if (decimals === undefined) continue;
    const ex = a.config.extra_decimals;
    const h = (x: string | undefined) => (x ? innerToHuman(x, decimals, ex) : 0);
    const supplied = h(a.supplied.balance);
    const borrowed = h(a.borrowed.balance);
    const liquidityInner =
      BigInt(a.supplied.balance) +
      BigInt(a.reserved ?? "0") +
      BigInt(a.prot_fee ?? "0") -
      BigInt(a.borrowed.balance) -
      BigInt(a.margin_debt?.balance ?? "0") -
      BigInt(a.margin_pending_debt ?? "0");
    const available =
      liquidityInner > BigInt(0) ? innerToHuman(liquidityInner.toString(), decimals, ex) : 0;
    const price = usd[a.token_id];
    out.push({
      tokenId: a.token_id,
      symbol: meta?.symbol ?? a.token_id,
      supplyAprPct: Number(a.supply_apr) * 100,
      borrowAprPct: Number(a.borrow_apr) * 100,
      utilizationPct: supplied > 0 ? (borrowed / supplied) * 100 : 0,
      totalSupplied: supplied,
      totalBorrowed: borrowed,
      availableLiquidity: available,
      totalSuppliedUsd: price !== undefined ? supplied * price : undefined,
      availableLiquidityUsd: price !== undefined ? available * price : undefined,
      priceUsd: price,
      collateralFactorPct: a.config.volatility_ratio / 100,
      canBorrow: a.config.can_borrow,
      canUseAsCollateral: a.config.can_use_as_collateral,
      canDeposit: a.config.can_deposit,
      verified: meta?.verified ?? false,
    });
  }
  out.sort((x, y) => (y.totalSuppliedUsd ?? 0) - (x.totalSuppliedUsd ?? 0));
  return out;
}

// ── Projection + oracle helpers (plan builder / vault preview) ────────────

/** Signed change to a position, in TOKEN base units (ft decimals, not inner). */
export type HealthDelta = { tokenId: string; collateralBase?: bigint; debtBase?: bigint };

export type HealthProjection = {
  /** null = no debt (cannot be liquidated). */
  before: number | null;
  after: number | null;
  /** Missing prices etc. When set, before/after may be null for that reason. */
  notes: string[];
};

/**
 * Health factor before/after applying `deltas` to an account's REGULAR
 * position, using the same oracle + formula as `readLendingPosition`.
 * Advisory: the vault contract re-checks with its own oracle read.
 */
export async function projectHealth(
  accountId: string,
  deltas: HealthDelta[],
): Promise<HealthProjection> {
  const batch = await view<unknown[]>(BURROW, "batch_views", {
    account_id: accountId,
    assets: false,
    config: true,
    margin_config: false,
    default_margin_base_token_limit: false,
    margin_base_token_limit: false,
    token_pyth_infos: true,
  });
  if (!batch) throw new Error("Rhea Lending batch_views returned nothing");
  const acct = batch[0] as BurrowAccount | null;
  const cfg = batch[3] as BurrowConfig;
  const infos = batch[7] as Record<string, PythInfo>;
  const reg = acct?.positions?.REGULAR ?? { collateral: [], borrowed: [] };
  const tokens = [
    ...new Set([...reg.collateral, ...reg.borrowed].map((a) => a.token_id).concat(deltas.map((d) => d.tokenId))),
  ];
  if (tokens.length === 0) return { before: null, after: null, notes: [] };
  const assets = await view<{ token_id: string; config: AssetConfig }[]>(BURROW, "get_assets", {
    token_ids: tokens,
  });
  const cfgOf = Object.fromEntries((assets ?? []).map((a) => [a.token_id, a.config]));
  const prices = await loadPrices(tokens, infos, cfg?.pyth_price_valid_duration_sec ?? PRICE_MAX_AGE_SEC);
  const notes: string[] = [];

  const coll = new Map<string, bigint>();
  const debt = new Map<string, bigint>();
  for (const a of reg.collateral) coll.set(a.token_id, (coll.get(a.token_id) ?? BigInt(0)) + BigInt(a.balance));
  for (const a of reg.borrowed) debt.set(a.token_id, (debt.get(a.token_id) ?? BigInt(0)) + BigInt(a.balance));

  const hf = (c: Map<string, bigint>, d: Map<string, bigint>): number | null | "error" => {
    let adjC = BigInt(0);
    let adjD = BigInt(0);
    let hasDebt = false;
    for (const [t, inner] of c) {
      if (inner <= BigInt(0)) continue;
      const p = prices.priceOf(t);
      const ac = cfgOf[t];
      if (!p || !ac) return "error";
      adjC += ((inner * p.mult * E18) / pow10(p.dec + ac.extra_decimals) * BigInt(ac.volatility_ratio)) / BPS;
    }
    for (const [t, inner] of d) {
      if (inner <= BigInt(0)) continue;
      hasDebt = true;
      const p = prices.priceOf(t);
      const ac = cfgOf[t];
      if (!p || !ac || ac.volatility_ratio === 0) return "error";
      const v = (inner * p.mult * E18) / pow10(p.dec + ac.extra_decimals);
      const r = BigInt(ac.volatility_ratio);
      adjD += (v * BPS + r - BigInt(1)) / r;
    }
    if (!hasDebt || adjD === BigInt(0)) return null;
    return Number((adjC * BPS) / adjD) / 10000;
  };

  const before = hf(coll, debt);
  const c2 = new Map(coll);
  const d2 = new Map(debt);
  for (const dl of deltas) {
    const ac = cfgOf[dl.tokenId];
    if (!ac) {
      notes.push(`${dl.tokenId} is not a Rhea Lending market.`);
      continue;
    }
    const k = pow10(ac.extra_decimals);
    if (dl.collateralBase) {
      const v = (c2.get(dl.tokenId) ?? BigInt(0)) + dl.collateralBase * k;
      c2.set(dl.tokenId, v < BigInt(0) ? BigInt(0) : v);
    }
    if (dl.debtBase) {
      const v = (d2.get(dl.tokenId) ?? BigInt(0)) + dl.debtBase * k;
      d2.set(dl.tokenId, v < BigInt(0) ? BigInt(0) : v);
    }
  }
  const after = hf(c2, d2);
  if (before === "error" || after === "error") {
    notes.push("An oracle price is missing for a token in this position; health factor not computed.");
  }
  if (!prices.fresh) notes.push("Some oracle prices were older than 60 seconds.");
  return {
    before: before === "error" ? null : before,
    after: after === "error" ? null : after,
    notes,
  };
}

/** Oracle USD prices (aggregate-oracle.near via Burrow's price ids). Missing ids omitted. */
export async function oraclePricesUsd(tokenIds: string[]): Promise<Record<string, number>> {
  const infos = (await view<Record<string, PythInfo>>(BURROW, "get_all_token_pyth_infos")) ?? {};
  const known = tokenIds.filter((t) => infos[t]);
  if (known.length === 0) return {};
  const prices = await loadPrices(known, infos, PRICE_MAX_AGE_SEC);
  const out: Record<string, number> = {};
  for (const t of known) {
    const p = prices.priceOf(t);
    if (p) out[t] = p.usd;
  }
  return out;
}

/** Current debt / collateral / supplied of one token in base units (rounded up for debt). */
export async function positionAmountsBase(
  accountId: string,
  tokenId: string,
): Promise<{ collateral: bigint; debt: bigint; supplied: bigint; extraDecimals: number; hasAnyDebt: boolean; debtAprPct: number }> {
  const [acct, assets] = await Promise.all([
    view<BurrowAccount>(BURROW, "get_account_all_positions", { account_id: accountId }),
    view<{ token_id: string; config: AssetConfig }[]>(BURROW, "get_assets", { token_ids: [tokenId] }),
  ]);
  const extra = assets?.[0]?.config.extra_decimals ?? 0;
  const k = pow10(extra);
  const reg = acct?.positions?.REGULAR ?? { collateral: [], borrowed: [] };
  const sum = (ls: AssetView[]) =>
    ls.filter((a) => a.token_id === tokenId).reduce((s, a) => s + BigInt(a.balance), BigInt(0));
  const debtInner = sum(reg.borrowed);
  const debtLine = reg.borrowed.find((a) => a.token_id === tokenId);
  return {
    collateral: sum(reg.collateral) / k,
    debt: (debtInner + k - BigInt(1)) / k,
    supplied: sum(acct?.supplied ?? []) / k,
    extraDecimals: extra,
    hasAnyDebt: reg.borrowed.length > 0,
    debtAprPct: debtLine ? Number(debtLine.apr) * 100 : 0,
  };
}

// Same math as contracts/vault/src/math.rs (bigint), so the worker never proposes what the vault rejects.
// Test vectors are shared with the contract's unit tests (see health.test.ts).

export type Price = { price: bigint; conf: bigint; expo: number; publishTime: number };
export type Leg = { valueUsd: bigint; volatilityRatioBps: number };

export const BPS = 10_000n;
export const USD_DECIMALS = 18;
export const HF_INFINITE = 2n ** 64n - 1n;

const pow10 = (e: number) => 10n ** BigInt(e);

export function parsePrice(v: any): Price | null {
  if (!v || typeof v !== "object") return null;
  try {
    return { price: BigInt(v.price), conf: BigInt(v.conf), expo: Number(v.expo), publishTime: Number(v.publish_time) };
  } catch {
    return null;
  }
}

export function checkPrice(p: Price, nowSec: number, maxAgeSec: number, maxConfBps: number): string | null {
  if (p.price <= 0n) return "non_positive_price";
  if (p.publishTime > nowSec + 60) return "price_from_future";
  if (nowSec - p.publishTime > maxAgeSec) return "stale_price";
  if (p.conf * BPS > p.price * BigInt(maxConfBps)) return "wide_confidence";
  return null;
}

/** USD value with 18 decimals of `amount` that has `decimals` decimals. */
export function usdValue(amount: bigint, decimals: number, p: Price): bigint {
  const num = amount * p.price;
  const scale = USD_DECIMALS + p.expo;
  return scale >= 0 ? (num * pow10(scale)) / pow10(decimals) : num / (pow10(decimals) * pow10(-scale));
}

/** Burrow formula: Σ coll × vol / Σ (debt / vol), in bps. */
export function healthFactorBps(collateral: Leg[], debt: Leg[]): bigint {
  let adjColl = 0n;
  for (const l of collateral) adjColl += (l.valueUsd * BigInt(l.volatilityRatioBps)) / BPS;
  let adjDebt = 0n;
  for (const l of debt) adjDebt += (l.valueUsd * BPS) / BigInt(Math.max(1, l.volatilityRatioBps));
  if (adjDebt === 0n) return HF_INFINITE;
  return (adjColl * BPS) / adjDebt;
}

/** Oracle-based minimum output for a swap after `slippageBps` (same as the vault). */
export function minOut(amountIn: bigint, decIn: number, pIn: Price, decOut: number, pOut: Price, slippageBps: number): bigint {
  let num = amountIn * pIn.price * pow10(decOut);
  let den = pOut.price * pow10(decIn);
  const e = pIn.expo - pOut.expo;
  if (e >= 0) num *= pow10(e);
  else den *= pow10(-e);
  return ((num / den) * (BPS - BigInt(slippageBps))) / BPS;
}

/**
 * Collateral value (USD e18) to withdraw so the health factor lands at `targetBps`:
 * (adjColl − x·vol) / adjDebt = target  ⇒  x = (adjColl − target·adjDebt) / vol.
 */
export function collateralValueForTarget(collateral: Leg[], debt: Leg[], withdrawVolBps: number, targetBps: bigint): bigint {
  let adjColl = 0n;
  for (const l of collateral) adjColl += (l.valueUsd * BigInt(l.volatilityRatioBps)) / BPS;
  let adjDebt = 0n;
  for (const l of debt) adjDebt += (l.valueUsd * BPS) / BigInt(Math.max(1, l.volatilityRatioBps));
  const excess = adjColl - (targetBps * adjDebt) / BPS;
  if (excess <= 0n) return 0n;
  return (excess * BPS) / BigInt(withdrawVolBps);
}

/** Convert a USD e18 value to token units (inverse of usdValue). */
export function unitsForValue(valueUsd: bigint, decimals: number, p: Price): bigint {
  const scale = USD_DECIMALS + p.expo;
  return scale >= 0 ? (valueUsd * pow10(decimals)) / (p.price * pow10(scale)) : (valueUsd * pow10(decimals) * pow10(-scale)) / p.price;
}

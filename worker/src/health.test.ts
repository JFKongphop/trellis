// Vectors shared with contracts/vault/src/math.rs tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPrice, collateralValueForTarget, healthFactorBps, HF_INFINITE, minOut, unitsForValue, usdValue, type Price } from "./health.ts";

const px = (price: bigint, expo: number): Price => ({ price, conf: 0n, expo, publishTime: 1000 });
const usd = (x: bigint) => x * 10n ** 18n;

test("prices", () => {
  const p: Price = { price: 500_000_000n, conf: 100_000n, expo: -8, publishTime: 1000 };
  assert.equal(checkPrice(p, 1030, 60, 100), null);
  assert.equal(checkPrice(p, 1061, 60, 100), "stale_price");
  assert.equal(checkPrice({ ...p, conf: 10_000_000n }, 1000, 60, 100), "wide_confidence");
});

test("usd values", () => {
  assert.equal(usdValue(10n * 10n ** 24n, 24, px(500_000_000n, -8)), usd(50n));
  assert.equal(usdValue(5n * 10n ** 18n, 18, px(100_000_000n, -8)), usd(5n));
});

test("health factor matches the contract", () => {
  assert.equal(healthFactorBps([{ valueUsd: usd(50n), volatilityRatioBps: 7500 }], [{ valueUsd: usd(5n), volatilityRatioBps: 9500 }]), 71_250n);
  assert.equal(healthFactorBps([{ valueUsd: usd(50n), volatilityRatioBps: 7500 }], []), HF_INFINITE);
  assert.equal(healthFactorBps([{ valueUsd: usd(90n), volatilityRatioBps: 7500 }], [{ valueUsd: usd(40n), volatilityRatioBps: 9500 }]), 16_031n);
});

test("min out matches the contract", () => {
  assert.equal(minOut(10n ** 24n, 24, px(500_000_000n, -8), 6, px(100_000_000n, -8), 100), 4_950_000n);
  assert.equal(minOut(5_000_000n, 6, px(100_000_000n, -8), 24, px(500_000_000n, -8), 100), 99n * 10n ** 22n);
  assert.equal(minOut(10n ** 24n, 24, px(500_000_000n, -8), 6, px(1_000_000n, -6), 100), 4_950_000n);
});

test("deleverage sizing lands on the target HF", () => {
  // 15 wNEAR @ $2.40 = $36 collateral (vol 0.75), 20 USDC debt (vol 0.95): HF ≈ 1.2825
  const coll = [{ valueUsd: usd(36n), volatilityRatioBps: 7500 }];
  const debt = [{ valueUsd: usd(20n), volatilityRatioBps: 9500 }];
  assert.equal(healthFactorBps(coll, debt), 12_825n);
  const value = collateralValueForTarget(coll, debt, 7500, 11_300n);
  const after = healthFactorBps([{ valueUsd: usd(36n) - value, volatilityRatioBps: 7500 }], debt);
  assert.ok(after >= 11_299n && after <= 11_301n, `after=${after}`);
  const units = unitsForValue(value, 24, px(240_000_000n, -8));
  // excess adj. collateral = 27 − 1.13 × 21.05 = 3.21 → / 0.75 = $4.28 → / $2.40 ≈ 1.78 wNEAR
  assert.ok(units > 17n * 10n ** 23n && units < 18n * 10n ** 23n, `units=${units}`);
  assert.equal(collateralValueForTarget(coll, debt, 7500, 13_000n), 0n, "already below target → nothing to withdraw");
});

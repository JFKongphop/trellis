import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMoneyFlow, stepsFromMoves } from "./flow-model.ts";

const edgeList = (f: ReturnType<typeof buildMoneyFlow>) => f.edges.map((e) => `${e.steps.join("-")} ${e.from}→${e.to} ${e.amount}`);

test("swap then supply: wallet → Ref pool → Rhea, no detour through the wallet", () => {
  const f = buildMoneyFlow(
    [
      { id: "s1", kind: "swap", tokenIn: "NEAR", amountIn: 10, tokenOut: "USDC", amountOut: 49.8, minOut: 49.3, pool: 4512 },
      { id: "s2", kind: "supply", tokenIn: "USDC", amountIn: 49.3, fromStep: "s1", label: "Supply 49.3 USDC to Rhea Lending as collateral" },
    ],
    { mode: "wallet", healthBefore: null, healthAfter: null },
  );
  assert.deepEqual(edgeList(f), ["1 wallet→ref:4512 10 NEAR", "1-2 ref:4512→rhea 49.3 USDC"]);
  const rhea = f.nodes.find((n) => n.id === "rhea")!;
  assert.deepEqual(rhea.details, ["collateral +49.3 USDC", "health factor ∞ → ∞"]);
});

test("output nobody uses goes back home", () => {
  const f = buildMoneyFlow([{ id: "w", kind: "wrap", amountIn: 5, amountOut: 5 }], { mode: "wallet" });
  assert.deepEqual(edgeList(f), ["1 wallet→wrap 5 NEAR", "1 wrap→wallet 5 wNEAR"]);
});

test("borrow lands in the vault and repay goes back to Rhea", () => {
  const f = buildMoneyFlow(
    [
      { id: "b", kind: "borrow", tokenOut: "USDC", amountOut: 30 },
      { id: "r", kind: "repay", tokenIn: "USDC", amountIn: 10 },
    ],
    { mode: "vault", healthBefore: 3.56, healthAfter: 2.4 },
  );
  assert.deepEqual(edgeList(f), ["1 rhea→vault 30 USDC", "2 vault→rhea 10 USDC"]);
  assert.deepEqual(f.nodes.find((n) => n.id === "rhea")!.details, ["debt +20 USDC", "health factor 3.56 → 2.40"]);
});

test("the agent's deleverage moves chain Rhea → Ref → Rhea", () => {
  const steps = stepsFromMoves([
    { id: "5", kind: "WithdrawCollateral", tokenOut: "wNEAR", amountOut: 2.812 },
    { id: "6", kind: "SwapRef", tokenIn: "wNEAR", amountIn: 2.812, tokenOut: "USDC", amountOut: 14.1349 },
    { id: "7", kind: "Repay", tokenIn: "USDC", amountIn: 14.1349 },
  ]);
  const f = buildMoneyFlow(steps, { mode: "vault", healthBefore: 1.247, healthAfter: 2.137 });
  assert.deepEqual(edgeList(f), ["1-2 rhea→ref:? 2.812 wNEAR", "2-3 ref:?→rhea 14.1349 USDC"]);
  assert.deepEqual(f.nodes.find((n) => n.id === "rhea")!.details, ["collateral −2.812 wNEAR", "debt −14.1349 USDC", "health factor 1.25 → 2.14"]);
});

test("send goes to a recipient node", () => {
  const f = buildMoneyFlow([{ id: "x", kind: "send", tokenIn: "USDC", amountIn: 5, to: "bob.near" }], { mode: "wallet" });
  assert.deepEqual(edgeList(f), ["1 wallet→to:bob.near 5 USDC"]);
});

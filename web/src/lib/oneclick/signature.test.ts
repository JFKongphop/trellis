import { test } from "node:test";
import assert from "node:assert/strict";
import { signedQuoteString, verifyQuoteSignature, type QuoteResponse } from "./signature.ts";

// Real 1Click dry quote (2026-10-21), from .claude/skills/near-intents/references/one-click-api.md §5.
const live: QuoteResponse = {
  quote: {
    amountIn: "5000000", amountInFormatted: "5.0", amountInUsd: "4.998500000000", minAmountIn: "5000000",
    amountOut: "931129435042566502055987", amountOutFormatted: "0.931129435042566502055987", amountOutUsd: "4.981542477478",
    minAmountOut: "921818140692140837035427", timeEstimate: 10, refundFee: "0", withdrawFee: "0",
  },
  quoteRequest: {
    dry: true, depositMode: "SIMPLE", swapType: "EXACT_INPUT", slippageTolerance: 100,
    originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", depositType: "INTENTS",
    destinationAsset: "nep141:wrap.near", amount: "5000000", refundTo: "sprout-demo.near", refundType: "INTENTS",
    recipient: "sprout-demo.near", recipientType: "INTENTS", deadline: "2026-10-21T18:20:18.000Z",
    confidentiality: "public", quoteWaitingTimeMs: 3000, insured: false,
    appFees: [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 20 }],
  },
  signature: "ed25519:nrEjMvMjZcpQn5iqFhWBw5utCFr7eDGTKJ1ynRdK3cUs2vXtDnszU9SJKfHF9AnQ6KWJKZxNQbiMT5p8c5ucrar",
  timestamp: "2026-10-21T18:10:18.355Z",
  correlationId: "378c1e04-b973-4a93-9b26-b38e376a8202",
};

const CANONICAL =
  '{"amount":"5000000","amountIn":"5000000","amountInFormatted":"5.0","amountInUsd":"4.998500000000","amountOut":"931129435042566502055987","amountOutFormatted":"0.931129435042566502055987","amountOutUsd":"4.981542477478","deadline":"2026-10-21T18:20:18.000Z","depositType":"INTENTS","destinationAsset":"nep141:wrap.near","dry":true,"minAmountIn":"5000000","minAmountOut":"921818140692140837035427","originAsset":"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","quoteWaitingTimeMs":3000,"recipient":"sprout-demo.near","recipientType":"INTENTS","refundTo":"sprout-demo.near","refundType":"INTENTS","slippageTolerance":100,"swapType":"EXACT_INPUT","timestamp":"2026-10-21T18:10:18.355Z"}';

test("canonical string matches what 1Click signed", () => {
  assert.equal(signedQuoteString(live), CANONICAL);
});

test("real signature verifies", () => {
  assert.equal(verifyQuoteSignature(live), true);
});

test("tampered recipient or amount fails", () => {
  assert.equal(verifyQuoteSignature({ ...live, quoteRequest: { ...live.quoteRequest, recipient: "attacker.near" } }), false);
  assert.equal(verifyQuoteSignature({ ...live, quote: { ...live.quote, amountOut: "1" } }), false);
});

test("unsigned fields (appFees) don't affect the signature", () => {
  assert.equal(verifyQuoteSignature({ ...live, quoteRequest: { ...live.quoteRequest, appFees: [] } }), true);
});

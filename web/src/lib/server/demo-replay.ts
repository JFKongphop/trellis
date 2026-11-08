import "server-only";

// Replay demo (`pnpm demo`): no sandbox, no worker. The numbers are from a recorded run of the live
// demo (`pnpm demo:live`, Oct 23 2026, or the testnet run below): the worker protected a ~1.25x wNEAR position after NEAR fell
// to $1.75. "Crash" replays the agent's three moves a few seconds apart; nothing is signed.
// State lives on globalThis so every route handler sees the same replay.
import { TOKENS, WRAP_NEAR } from "@/lib/near/config";
import type { AccountBalances, TokenBalance } from "@/lib/near/balances";
import type { LendingPosition } from "@/lib/near/burrow";
import type { VaultPolicy, VaultReceipt, VaultStatus, VaultTokenInfo } from "@/lib/near/vault";
import type { FeedItem, FeedResponse } from "@/lib/feed";
import type { DemoInfo } from "@/lib/demo";
import type { VaultPlan } from "@/lib/ai/plan-types";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";

export const replayEnabled = () => process.env.DEMO_MODE === "replay";

// Two recordings. Default: the local sandbox run (Oct 23 2026), with placeholder tx hashes.
// NEXT_PUBLIC_NEAR_NETWORK=testnet: the NEAR testnet run (Nov 7 2026, trellis/testnet/deployment.json) at 1/10 the
// amounts, with the agent's key in OutLayer's TEE; every receipt links to its real testnet transaction.
const TESTNET = process.env.NEXT_PUBLIC_NEAR_NETWORK === "testnet";

export const REPLAY = TESTNET
  ? {
      owner: "alice-trellis-mw6tffvj.testnet",
      vault: "v866c8a018d8854a3.app.trellis-mw6t5fzt.testnet",
      factory: "app.trellis-mw6t5fzt.testnet",
      agent: "a48ed23b485f0d5899757f37ac41c8c1ad25e9477e5aab7ed185bd341998d7cc",
      ownerNear: 2.4031,
    }
  : {
      owner: "alice.test.near",
      vault: "v0b53e6c36ede12dc.trellis.test.near",
      factory: "trellis.test.near",
      agent: "agent.test.near",
      ownerNear: 291.9795,
    };

/** The recorded numbers (wNEAR / USDC amounts) and, on testnet, the real transaction of each move. */
const RUN = TESTNET
  ? {
      supply1: 2, borrow: 3, swapOut: 0.591128, supply2: 1, idleWnear: 0.091128, vaultNear: 1.8008,
      withdraw: 0.281203, swapUsdc: 1.4275, capW: 5, capU: 30, perW: 2, perU: 10, ownerWnear: 0.1, ownerUsdc: 10, k: 0.1,
      tx: {
        "1": "BaAySERdMVtbz8AJBTGhDGV3hPSyL3rzLbBAoWM1Naib",
        "2": "GKEzYxa1g3AcZjeVXc6UfL4pZS14P5YzgPmTNgRPSM5M",
        "3": "HHZnmFzoG7Co6tC8AVcgdubaSkZk58jmXthw5CWBuHJx",
        "4": "DGA1arWSFGxyhJEGsSg6WoaSXeAia9B78m1ow1TN6pBj",
        "5": "Gah22jsXE3K7oxgmeph3rZrxAJQMVD9VwF15L85K9ewk",
        "6": "8BQuAqdHE4MrRhSE2BYD12MnwACDwYhpwfMZqCxMLxkE",
        "7": "GmuKA6SFbQDfQvBFAW35tvwbcbs48FCp4ecpXoBYLH38",
      } as Record<string, string>,
    }
  : {
      supply1: 20, borrow: 30, swapOut: 5.9496, supply2: 10, idleWnear: 0.949645, vaultNear: 3.8352,
      withdraw: 2.812, swapUsdc: 14.1349, capW: 50, capU: 300, perW: 20, perU: 100, ownerWnear: 175, ownerUsdc: 100, k: 1,
      tx: {} as Record<string, string>,
    };
const COLL0 = RUN.supply1 + RUN.supply2;
const DEBT0 = RUN.borrow;

const USDC = TOKENS.USDC;
const E24 = BigInt(10) ** BigInt(24);
const START_PRICE = 5;
const CRASH_PRICE = 1.75;
const STEP_MS = 4_000; // the worker ticks every 3 s; one move every ~4 s

type Phase = { price: number; crashAt: number | null; bootAt: number; frozenMs: number | null };
const g = globalThis as unknown as { __trellisReplay?: Phase };
const phase = (): Phase => (g.__trellisReplay ??= { price: START_PRICE, crashAt: null, bootAt: Date.now(), frozenMs: null });

/** Price ≤ $2 replays the recorded crash (at $1.75); anything else is a calm market at that price. */
/** `step` (0–3) freezes the replay right after that many agent moves (used to record the demo video). */
export function setReplayPrice(usd: number, step?: number): number {
  const p = phase();
  if (usd <= 2) {
    p.price = CRASH_PRICE;
    const frozen = step === undefined ? null : Math.max(0, Math.min(3, Math.floor(step))) * STEP_MS + 500;
    p.crashAt = Date.now() - (frozen ?? 0);
    p.frozenMs = frozen;
  } else {
    p.price = usd;
    p.crashAt = null;
    p.frozenMs = null;
  }
  return p.price;
}

const ns = (ms: number) => (BigInt(Math.round(ms)) * BigInt(1_000_000)).toString();
const raw = (n: number, dec: number) => {
  const [i, f = ""] = n.toFixed(Math.min(dec, 12)).split(".");
  return (BigInt(i) * BigInt(10) ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0")).toString();
};
const hfOf = (coll: number, debt: number, price: number) => (debt > 0 ? (coll * price * 0.75) / (debt / 0.95) : null);
const bps = (hf: number | null) => (hf === null ? null : String(Math.round(hf * 10_000)));

function receipt(r: Partial<VaultReceipt> & Pick<VaultReceipt, "op_id" | "kind" | "timestamp">): VaultReceipt {
  return {
    status: "Settled",
    token_in: null,
    amount_in: "0",
    token_out: null,
    amount_out: "0",
    health_factor_bps: null,
    note: "",
    reason_hash: `replay-${r.op_id}`,
    tx_hash: RUN.tx[r.op_id] ?? `REPLAY${r.op_id}${"x".repeat(38)}`,
    ...r,
  };
}

type World = {
  price: number;
  coll: number; // wNEAR collateral
  debt: number; // USDC debt
  vaultWnear: number;
  vaultUsdc: number;
  wnearUsed: number;
  receipts: VaultReceipt[]; // newest first
  pending: VaultStatus["pending_deleverage"];
  lastHf: number | null;
};

/** The vault at this moment of the replay. */
function world(now = Date.now()): World {
  const p = phase();
  const setup = p.bootAt - 2 * 60_000;
  const receipts: VaultReceipt[] = [
    receipt({ op_id: "4", kind: "Supply", timestamp: ns(setup + 30_000), token_in: WRAP_NEAR, amount_in: raw(RUN.supply2, 24), amount_out: raw(RUN.supply2, 24), origin: "plan" }),
    receipt({ op_id: "3", kind: "SwapRef", timestamp: ns(setup + 20_000), token_in: USDC, amount_in: raw(RUN.borrow, 6), token_out: WRAP_NEAR, amount_out: raw(RUN.swapOut, 24), origin: "plan" }),
    receipt({ op_id: "2", kind: "Borrow", timestamp: ns(setup + 10_000), token_out: USDC, amount_out: raw(RUN.borrow, 6), health_factor_bps: "23700", origin: "plan" }),
    receipt({ op_id: "1", kind: "Supply", timestamp: ns(setup), token_in: WRAP_NEAR, amount_in: raw(RUN.supply1, 24), amount_out: raw(RUN.supply1, 24), origin: "plan" }),
  ];
  const w: World = { price: p.price, coll: COLL0, debt: DEBT0, vaultWnear: RUN.idleWnear, vaultUsdc: 0, wnearUsed: COLL0, receipts, pending: null, lastHf: 2.37 };
  if (p.crashAt === null) return w;

  const t = p.frozenMs ?? now - p.crashAt;
  const hfBefore = hfOf(COLL0, DEBT0, CRASH_PRICE)!; // 1.247
  if (t >= STEP_MS) {
    w.coll = COLL0 - RUN.withdraw;
    w.vaultWnear += RUN.withdraw;
    w.lastHf = 1.13;
    w.pending = { collateral_token: WRAP_NEAR, collateral_left: raw(RUN.withdraw, 24), debt_token: null, repay_due: "0", started_at: ns(p.crashAt + STEP_MS) };
    w.receipts.unshift(
      receipt({
        op_id: "5", kind: "WithdrawCollateral", timestamp: ns(p.crashAt + STEP_MS), token_out: WRAP_NEAR, amount_out: raw(RUN.withdraw, 24),
        health_factor_bps: "11300", origin: "auto", why: "HF 1.247 < min 1.500; target HF after withdraw 1.130", hf_before_bps: bps(hfBefore),
      }),
    );
  }
  if (t >= 2 * STEP_MS) {
    w.vaultWnear -= RUN.withdraw;
    w.vaultUsdc = RUN.swapUsdc;
    w.wnearUsed = COLL0 + RUN.withdraw;
    w.pending = { collateral_token: WRAP_NEAR, collateral_left: "0", debt_token: USDC, repay_due: raw(RUN.swapUsdc, 6), started_at: w.pending!.started_at };
    w.receipts.unshift(
      receipt({
        op_id: "6", kind: "SwapRef", timestamp: ns(p.crashAt + 2 * STEP_MS), token_in: WRAP_NEAR, amount_in: raw(RUN.withdraw, 24), token_out: USDC,
        amount_out: raw(RUN.swapUsdc, 6), origin: "auto", why: "deleverage: convert withdrawn collateral to the debt token", hf_before_bps: "11300",
      }),
    );
  }
  if (t >= 3 * STEP_MS) {
    w.vaultUsdc = 0;
    w.debt = DEBT0 - RUN.swapUsdc;
    w.pending = null;
    w.lastHf = hfOf(w.coll, w.debt, CRASH_PRICE);
    w.receipts.unshift(
      receipt({
        op_id: "7", kind: "Repay", timestamp: ns(p.crashAt + 3 * STEP_MS), token_in: USDC, amount_in: raw(RUN.swapUsdc, 6), amount_out: raw(RUN.swapUsdc, 6),
        origin: "auto", why: "deleverage: repay debt", hf_before_bps: "11300",
      }),
    );
  }
  return w;
}

function tokenRow(tokenId: string, symbol: string, decimals: number, balance: number, priceUsd: number): TokenBalance {
  return { tokenId, symbol, decimals, balance, balanceRaw: raw(balance, decimals), priceUsd, valueUsd: balance * priceUsd, verified: true };
}

function vaultBalances(w: World): AccountBalances {
  const rows = [tokenRow("near", "NEAR", 24, RUN.vaultNear, w.price), tokenRow(WRAP_NEAR, "wNEAR", 24, w.vaultWnear, w.price)];
  if (w.vaultUsdc > 0) rows.push(tokenRow(USDC, "USDC", 6, w.vaultUsdc, 1));
  return { accountId: REPLAY.vault, exists: true, balances: rows, totalUsd: rows.reduce((s, r) => s + (r.valueUsd ?? 0), 0) };
}

export function replayBalances(account: string): AccountBalances {
  const w = world();
  if (account === REPLAY.vault) return vaultBalances(w);
  const rows = [tokenRow("near", "NEAR", 24, REPLAY.ownerNear, w.price), tokenRow(WRAP_NEAR, "wNEAR", 24, RUN.ownerWnear, w.price), tokenRow(USDC, "USDC", 6, RUN.ownerUsdc, 1)];
  return { accountId: account, exists: account === REPLAY.owner, balances: account === REPLAY.owner ? rows : [], totalUsd: account === REPLAY.owner ? rows.reduce((s, r) => s + (r.valueUsd ?? 0), 0) : 0 };
}

export function replayPosition(account: string): LendingPosition {
  const w = world();
  if (account !== REPLAY.vault) {
    return { accountId: account, registered: false, collateral: [], borrowed: [], supplied: [], healthFactor: null, liquidationPrices: [], pricesFresh: true, notes: [] };
  }
  const collUsd = w.coll * w.price;
  const hf = hfOf(w.coll, w.debt, w.price);
  return {
    accountId: account,
    registered: true,
    collateral: [{ tokenId: WRAP_NEAR, symbol: "wNEAR", amount: w.coll, valueUsd: collUsd, aprPct: 0, collateralFactorPct: 75 }],
    borrowed: [{ tokenId: USDC, symbol: "USDC", amount: w.debt, valueUsd: w.debt, aprPct: 0.02, collateralFactorPct: 95 }],
    supplied: [],
    healthFactor: hf,
    adjustedCollateralUsd: collUsd * 0.75,
    adjustedDebtUsd: w.debt / 0.95,
    totalCollateralUsd: collUsd,
    totalDebtUsd: w.debt,
    netValueUsd: collUsd - w.debt,
    liquidationPrices: hf
      ? [{ tokenId: WRAP_NEAR, symbol: "wNEAR", currentPriceUsd: w.price, liquidationPriceUsd: w.price / hf, dropPct: (1 - 1 / hf) * 100 }]
      : [],
    loanToValuePct: (w.debt / collUsd) * 100,
    pricesFresh: true,
    notes: [],
  };
}

const POLICY: VaultPolicy = {
  allowed_tokens: [WRAP_NEAR, USDC],
  allowed_ref_pools: [0],
  per_action_cap: [[WRAP_NEAR, (BigInt(RUN.perW) * E24).toString()], [USDC, raw(RUN.perU, 6)]],
  daily_cap: [[WRAP_NEAR, (BigInt(RUN.capW) * E24).toString()], [USDC, raw(RUN.capU, 6)]],
  max_slippage_bps: 200,
  max_intents_spread_bps: 50,
  min_health_factor_bps: 15000,
  deleverage_trigger_bps: 13000,
  emergency_floor_bps: 11000,
  max_price_age_sec: 60,
  max_price_conf_bps: 100,
  burrow_enabled: true,
  ref_enabled: true,
  intents_enabled: false,
  intents_quote_pubkey: null,
  min_near_reserve: "500000000000000000000000",
  max_storage_spend: "2000000000000000000000000",
};
const TOKENS_INFO: [string, VaultTokenInfo][] = [
  [WRAP_NEAR, { decimals: 24, burrow_extra_decimals: 0, price_id: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750", volatility_ratio_bps: 7500 }],
  [USDC, { decimals: 6, burrow_extra_decimals: 12, price_id: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", volatility_ratio_bps: 9500 }],
];

/** Same shape as GET /api/vault/state?id=. */
export function replayVaultState(vaultId: string) {
  const w = world();
  const status: VaultStatus = {
    owner: REPLAY.owner,
    agent: REPLAY.agent,
    agent_expires_at: null,
    paused: false,
    in_flight: null,
    near_available: raw(RUN.vaultNear, 24),
    storage_spent: "0",
    last_health: w.lastHf ? { health_factor_bps: bps(w.lastHf)!, collateral_usd_e18: "0", debt_usd_e18: "0", timestamp: ns(Date.now()) } : null,
    day: String(Math.floor(Date.now() / 86_400_000)),
    pending_deleverage: w.pending,
  };
  return {
    vaultId,
    status,
    policy: POLICY,
    tokens: TOKENS_INFO,
    receipts: w.receipts,
    remaining: { [WRAP_NEAR]: raw(RUN.capW - w.wnearUsed, 24), [USDC]: raw(RUN.capU - RUN.borrow, 6) },
    balances: vaultBalances(w),
    position: replayPosition(vaultId),
    protocolsReady: true,
  };
}

export function replayOwner(owner: string) {
  return {
    owner,
    vaultId: owner === REPLAY.owner ? REPLAY.vault : null,
    predictedId: REPLAY.vault,
    minDeposit: raw(1.5, 24),
    factory: REPLAY.factory,
    agent: REPLAY.agent,
  };
}

export function replayFeed(): FeedResponse {
  const w = world();
  const items: FeedItem[] = w.receipts.map((r) => ({ ...r, vault_id: REPLAY.vault }));
  return {
    configured: true,
    vaults: 1,
    items,
    stats: {
      moves: items.length,
      automatic: items.filter((r) => r.origin === "auto").length,
      failed: 0,
      vaultsActive: 1,
    },
    generatedAt: Date.now(),
  };
}

export function replayInfo(): DemoInfo {
  return { accountId: REPLAY.owner, vault: REPLAY.vault, nearUsd: phase().price, startNearUsd: START_PRICE, mode: "replay", nearBalance: REPLAY.ownerNear };
}

// ── Replayed chat ("loop my vault to 1.8x") ───────────────────────────────
// No LLM in the replay: /api/chat streams a scripted answer in the AI SDK's UI-message format, with a
// `proposeVaultActions` tool call; /api/vault/preview answers with the recorded plan below. The plan
// card, money-flow graph and Guardian render exactly as they do live. Approving it does nothing here.


/** 1.25x → ~1.8x: borrow 66 USDC, swap to wNEAR on Ref, supply it. HF 3.56 → 1.60 (min 1.50). */
export function replayVaultPlan(): { plan: VaultPlan; approval: { token: string; planId: string; expiresAt: number } } {
  const k = RUN.k; // testnet: 1/10 of the sandbox amounts
  const n = (x: number) => +(x * k).toFixed(4);
  const plan: VaultPlan = {
    mode: "vault",
    vaultId: REPLAY.vault,
    owner: REPLAY.owner,
    steps: [
      { id: "borrow", kind: "borrow", label: `Borrow ${n(66)} USDC into the vault (then sync)`, tokenOut: "USDC", amountOut: n(66), refs: [0] },
      {
        id: "swap", kind: "swap", label: `Swap ${n(66)} USDC for about ${n(13.14)} wNEAR (at least ${n(12.88)}) on Ref pool 0`,
        tokenIn: "USDC", amountIn: n(66), tokenOut: "wNEAR", amountOut: n(13.14), minOut: n(12.88), refs: [1], pool: 0, fromStep: "borrow",
      },
      { id: "supply", kind: "supply", label: `Supply ${n(12.88)} wNEAR to Rhea Lending as collateral`, tokenIn: "wNEAR", amountIn: n(12.88), refs: [2], fromStep: "swap" },
    ],
    calls: [
      { method: "agent_borrow", args: { token: TOKENS.USDC, amount: raw(n(66), 6) }, label: `Borrow ${n(66)} USDC` },
      { method: "agent_swap_ref", args: { pool_id: 0, token_in: TOKENS.USDC, token_out: WRAP_NEAR, amount_in: raw(n(66), 6) }, label: `Swap ${n(66)} USDC → wNEAR (pool 0)` },
      { method: "agent_supply", args: { token: WRAP_NEAR, amount: raw(n(12.88), 24) }, label: `Supply ${n(12.88)} wNEAR` },
    ],
    guardian: [
      { id: "hf", source: "check", level: "pass", title: "Health factor after: 1.60", note: "Above your 1.50 minimum. The vault re-checks it with oracle prices before the borrow." },
      { id: "caps", source: "check", level: "pass", title: "Within today's limits", note: `${n(66)} of ${n(270)} USDC left today; ${n(12.88)} of ${n(20)} wNEAR left today.` },
      { id: "impact", source: "check", level: "pass", title: "Price vs oracle: 0.42%", note: "Inside your 2% max slippage. The vault sets the minimum output from the oracle itself." },
      { id: "rate", source: "agent", level: "flag", title: "Borrow cost is variable", note: "USDC borrow APR moves with utilization; interest slowly lowers the health factor." },
    ],
    blocked: false,
    summary: `Loop the vault from ~1.25x to ~1.8x: borrow ${n(66)} USDC, swap it to wNEAR on Ref, supply it as collateral.`,
    healthBefore: 3.56,
    healthAfter: 1.6,
    createdAt: Date.now(),
  };
  return { plan, approval: { token: "replay", planId: "replay-loop", expiresAt: Date.now() + 5 * 60_000 } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scripted assistant turn: text, then (first turn) the proposeVaultActions tool call. */
export function replayChatResponse(messages: UIMessage[]): Response {
  const last = messages[messages.length - 1];
  const followUp = last?.role === "assistant";
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const say = async (text: string) => {
        const id = `t${Math.random().toString(36).slice(2)}`;
        writer.write({ type: "text-start", id });
        for (const word of text.split(/(?<= )/)) {
          writer.write({ type: "text-delta", id, delta: word });
          await sleep(28);
        }
        writer.write({ type: "text-end", id });
      };
      writer.write({ type: "start" });
      writer.write({ type: "start-step" });
      if (!followUp) {
        await sleep(500);
        await say(
          "Your vault is at **1.25x** with a health factor of **3.56**, so there's room to loop. Here's a plan to reach about **1.8x** while staying above your 1.5 minimum:",
        );
        const toolCallId = `call_${Math.random().toString(36).slice(2)}`;
        writer.write({ type: "tool-input-start", toolCallId, toolName: "proposeVaultActions" });
        writer.write({
          type: "tool-input-available",
          toolCallId,
          toolName: "proposeVaultActions",
          input: {
            reasoning: "Loop to ~1.8x: borrow USDC, swap to wNEAR on Ref, supply as collateral; HF stays above 1.5.",
            steps: [
              { id: "borrow", kind: "borrow", token: "USDC", amount: +(66 * RUN.k).toFixed(4) },
              { id: "swap", kind: "swap", tokenIn: "USDC", tokenOut: "wNEAR", origin: { from: "step", stepId: "borrow" } },
              { id: "supply", kind: "supply", token: "wNEAR", origin: { from: "step", stepId: "swap" } },
            ],
          },
        });
      } else {
        await say(
          "The health factor goes from 3.56 to **1.60**, above your 1.5 minimum, and your vault contract re-checks every step against your rules. Click **Approve** and the agent runs it, with no wallet popup.",
        );
      }
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

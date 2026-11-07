import "server-only";

// Shared helpers for the plan builders: token resolution, NEP-145 storage
// checks, Ref quotes with an oracle cross-check.

import { view, readProvider } from "@/lib/near/rpc";
import {
  NATIVE_NEAR_ID,
  NEAR_DECIMALS,
  REF_EXCHANGE,
  TOKENS,
  WRAP_NEAR,
  isValidAccountId,
} from "@/lib/near/config";
import { tokenMeta, searchTokens } from "@/lib/near/tokens";
import { oraclePricesUsd } from "@/lib/near/burrow";
import { fromBase } from "@/lib/near/tx";

/** Thrown for input the model can fix; `fix` is shown to the model. */
export class PlanError extends Error {
  constructor(message: string, public fix?: string) {
    super(fix ? `${message} FIX: ${fix}` : message);
  }
}

export type ResolvedToken = { id: string; symbol: string; decimals: number; native: boolean };

const SYMBOLS: Record<string, string> = {
  wnear: WRAP_NEAR,
  usdc: TOKENS.USDC,
  usdt: TOKENS.USDT,
  "usdc.e": TOKENS["USDC.e"],
  "usdt.e": TOKENS["USDT.e"],
};

export async function resolveToken(input: string): Promise<ResolvedToken> {
  const q = input.trim().toLowerCase();
  if (q === "near" || q === NATIVE_NEAR_ID) {
    return { id: NATIVE_NEAR_ID, symbol: "NEAR", decimals: NEAR_DECIMALS, native: true };
  }
  let id = SYMBOLS[q];
  if (!id && isValidAccountId(q) && (q.includes(".") || /^[0-9a-f]{64}$/.test(q))) id = q;
  if (!id) {
    const hits = (await searchTokens(q, 8)).filter((h) => h.verified && h.symbol.toLowerCase() === q);
    if (hits.length === 1) id = hits[0].id;
    else if (hits.length > 1) {
      throw new PlanError(
        `"${input}" matches several verified tokens.`,
        `Call searchToken("${input}") and pass the token account id instead of the symbol.`,
      );
    }
  }
  if (!id) {
    throw new PlanError(`Unknown token "${input}".`, `Call searchToken("${input}") and pass its account id.`);
  }
  const m = await tokenMeta(id);
  if (!m) throw new PlanError(`${id} is not a fungible token.`);
  return { id, symbol: m.symbol, decimals: m.decimals, native: false };
}

/** Contract id that holds a token's balance (native NEAR → wrap.near when wrapped). */
export const ftId = (t: ResolvedToken) => (t.native ? WRAP_NEAR : t.id);

const boundsCache = new Map<string, bigint>();
/** NEP-145 minimum storage deposit for `contract` (falls back to 0.00125 NEAR). */
export async function storageMin(contract: string): Promise<bigint> {
  const hit = boundsCache.get(contract);
  if (hit !== undefined) return hit;
  const b = await view<{ min: string }>(contract, "storage_balance_bounds").catch(() => null);
  const v = b?.min ? BigInt(b.min) : BigInt("1250000000000000000000");
  boundsCache.set(contract, v);
  return v;
}

export async function isStorageRegistered(contract: string, account: string): Promise<boolean> {
  const r = await view<object>(contract, "storage_balance_of", { account_id: account }).catch(() => null);
  return !!r;
}

export async function accountExists(id: string): Promise<boolean> {
  try {
    await readProvider().viewAccount({ accountId: id, blockQuery: { finality: "final" } });
    return true;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/does not exist|AccountDoesNotExist/i.test(msg) || (e as Error)?.name === "AccountDoesNotExistError") {
      return false;
    }
    throw e;
  }
}

export type SwapQuote = {
  amountOut: bigint;
  minOut: bigint;
  /** Output the oracle prices imply, human units (undefined if no oracle price). */
  oracleOut?: number;
  /** % worse than the oracle-implied output (fees + impact); undefined without oracle. */
  impactPct?: number;
};

/** Ref `get_return` on one pool, minOut with slippage, oracle cross-check. */
export async function quoteRef(
  poolId: number,
  tokenIn: ResolvedToken,
  tokenOut: ResolvedToken,
  amountIn: bigint,
  slippageBps: number,
): Promise<SwapQuote> {
  const inId = ftId(tokenIn);
  const outId = ftId(tokenOut);
  const out = await view<string>(REF_EXCHANGE, "get_return", {
    pool_id: poolId,
    token_in: inId,
    amount_in: amountIn.toString(),
    token_out: outId,
  });
  if (!out || out === "0") throw new PlanError(`Ref pool ${poolId} can't fill this swap.`);
  const amountOut = BigInt(out);
  const minOut = (amountOut * BigInt(10000 - slippageBps)) / BigInt(10000);
  const px = await oraclePricesUsd([inId, outId]).catch(() => ({}) as Record<string, number>);
  let oracleOut: number | undefined;
  let impactPct: number | undefined;
  if (px[inId] && px[outId]) {
    oracleOut = (fromBase(amountIn, tokenIn.decimals) * px[inId]) / px[outId];
    impactPct = (1 - fromBase(amountOut, tokenOut.decimals) / oracleOut) * 100;
  }
  return { amountOut, minOut, oracleOut, impactPct };
}

export const fmt = (n: number, dp = 4) =>
  n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? dp : 6 });

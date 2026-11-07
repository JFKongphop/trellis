import "server-only";

// 1Click REST client (https://1click.chaindefuser.com/v0). Works without a key; with
// ONECLICK_API_KEY (partner JWT from partners.near-intents.org) the fee is lower.
import type { QuoteRequest, QuoteResponse } from "@/lib/oneclick/signature";

const BASE = "https://1click.chaindefuser.com/v0";

export class OneClickError extends Error {}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = process.env.ONECLICK_API_KEY;
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(key ? { "X-API-Key": key } : {}), ...(init.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    throw new OneClickError(`1Click unreachable: ${(e as Error).message}`);
  }
  const text = await r.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text in the error below
  }
  if (!r.ok) {
    const msg = (body as { message?: string } | null)?.message ?? text.slice(0, 200);
    throw new OneClickError(r.status === 404 ? "not_found" : `1Click: ${msg}`);
  }
  return body as T;
}

export const oneClickQuote = (req: QuoteRequest) =>
  call<QuoteResponse>("/quote", { method: "POST", body: JSON.stringify(req) });

export type OneClickStatus = {
  status: string;
  updatedAt?: string;
  swapDetails?: {
    amountOutFormatted?: string;
    refundedAmountFormatted?: string;
    refundReason?: string;
    originChainTxHashes?: { hash: string; explorerUrl?: string }[];
    nearTxHashes?: string[];
  };
};

export const oneClickStatus = (depositAddress: string, depositMemo?: string) =>
  call<OneClickStatus>(
    `/status?depositAddress=${encodeURIComponent(depositAddress)}${depositMemo ? `&depositMemo=${encodeURIComponent(depositMemo)}` : ""}`,
  );

/** Optional: tell 1Click the origin-chain tx so it picks the deposit up sooner. */
export const oneClickSubmitDeposit = (txHash: string, depositAddress: string) =>
  call<OneClickStatus>("/deposit/submit", { method: "POST", body: JSON.stringify({ txHash, depositAddress }) });

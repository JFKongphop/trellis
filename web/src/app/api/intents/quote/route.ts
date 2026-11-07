import { DESTINATION_ASSETS, ORIGIN_ASSETS, validRefundAddress, type IntentsQuote } from "@/lib/oneclick/assets";
import { verifyQuoteSignature, type QuoteRequest } from "@/lib/oneclick/signature";
import { oneClickQuote, OneClickError } from "@/lib/server/oneclick";
import { isStorageRegistered } from "@/lib/plan/common";
import { isValidAccountId } from "@/lib/near/config";
import { fromBase, toBase } from "@/lib/near/tx";
import { readProvider } from "@/lib/near/rpc";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";
export const maxDuration = 40;

/**
 * Quote for funding a NEAR account (the user's vault or wallet) from another chain.
 * `dry: true` is a preview; `dry: false` returns a one-time deposit address on the origin chain.
 * Delivery is straight to the account as a NEP-141 token (recipientType DESTINATION_CHAIN);
 * refunds go back to `refundTo` on the origin chain. Every quote's 1Click signature is checked.
 */
export async function POST(req: Request) {
  // 1Click is real money on mainnet; the demo's accounts only exist in the local sandbox.
  if (process.env.DEMO_MODE === "1") return json({ error: "Cross-chain funding is off in demo mode: it moves real money on mainnet." }, 400);
  const b = (await req.json().catch(() => null)) as {
    originAsset?: string;
    destinationAsset?: string;
    amount?: string;
    refundTo?: string;
    recipient?: string;
    dry?: boolean;
  } | null;
  const origin = ORIGIN_ASSETS.find((a) => a.id === b?.originAsset);
  const dest = DESTINATION_ASSETS.find((a) => a.id === b?.destinationAsset);
  const recipient = String(b?.recipient ?? "").trim().toLowerCase();
  const refundTo = String(b?.refundTo ?? "").trim();
  const dry = b?.dry !== false;
  if (!origin || !dest) return json({ error: "Unsupported asset." }, 400);
  if (!isValidAccountId(recipient)) return json({ error: "Invalid NEAR recipient." }, 400);
  if (!validRefundAddress(origin.addressKind, refundTo)) {
    return json({ error: `Enter your ${origin.chainLabel} address for refunds.` }, 400);
  }
  let amount: bigint;
  try {
    amount = toBase(String(b?.amount ?? ""), origin.decimals);
  } catch {
    return json({ error: "Invalid amount." }, 400);
  }
  if (amount <= BigInt(0)) return json({ error: "Enter an amount." }, 400);

  try {
    // NEAR delivery needs an existing account that's registered on the token, or 1Click can't pay out.
    const exists = await readProvider()
      .viewAccount({ accountId: recipient })
      .then(() => true)
      .catch(() => false);
    if (!exists) return json({ error: `${recipient} doesn't exist on NEAR.` }, 400);
    if (!(await isStorageRegistered(dest.token, recipient))) {
      return json({ error: `${recipient} isn't registered for ${dest.symbol} yet.`, code: "not_registered", token: dest.token }, 400);
    }

    const request: QuoteRequest = {
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: origin.id,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: dest.id,
      amount: amount.toString(),
      refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + origin.windowMin * 60_000).toISOString(),
      quoteWaitingTimeMs: 3000,
    };
    const r = await oneClickQuote(request);

    // Trust nothing we didn't ask for: signature + the fields that decide where funds go.
    const q = r.quoteRequest;
    if (!verifyQuoteSignature(r)) return json({ error: "1Click quote signature didn't verify." }, 502);
    const mismatch =
      q.recipient !== recipient ||
      q.recipientType !== "DESTINATION_CHAIN" ||
      q.refundTo !== refundTo ||
      q.refundType !== "ORIGIN_CHAIN" ||
      q.destinationAsset !== dest.id ||
      q.amount !== request.amount ||
      q.dry !== dry ||
      !!q.customRecipientMsg ||
      !!q.virtualChainRecipient;
    if (mismatch) return json({ error: "1Click returned a quote for different terms." }, 502);
    if (!dry && !r.quote.depositAddress) return json({ error: "1Click didn't return a deposit address." }, 502);

    const out: IntentsQuote = {
      dry,
      origin: origin.id,
      destination: dest.id,
      recipient,
      amountIn: r.quote.amountIn,
      amountInFormatted: r.quote.amountInFormatted,
      amountInUsd: r.quote.amountInUsd,
      amountOutFormatted: r.quote.amountOutFormatted,
      amountOutUsd: r.quote.amountOutUsd,
      minAmountOutFormatted: fromBase(r.quote.minAmountOut, dest.decimals).toString(),
      timeEstimate: r.quote.timeEstimate,
      depositAddress: r.quote.depositAddress,
      depositMemo: r.quote.depositMemo,
      deadline: r.quote.deadline ?? q.deadline,
      correlationId: r.correlationId,
      raw: r,
    };
    return json(out);
  } catch (e) {
    const msg = e instanceof OneClickError ? e.message : `Quote failed: ${errorMessage(e)}`;
    return json({ error: msg }, 502);
  }
}

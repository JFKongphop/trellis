// 1Click quote signature check (server side; uses node:crypto).
// 1Click signs base58(sha256(stableStringify(subset of quoteRequest + quote + timestamp))) with ed25519.
// Mirrors @defuse-protocol/one-click-sdk-typescript 0.1.26 `verifyQuoteSignature`
// (.claude/skills/near-intents/references/one-click-api.md §6).
import { createHash, createPublicKey, verify } from "node:crypto";

/** 1Click quote-signing key (hard-coded in the official SDK as ONE_CLICK_MANAGER_PUB_KEY). */
export const ONE_CLICK_PUBKEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  const base = BigInt(58);
  while (n > BigInt(0)) {
    out = B58[Number(n % base)] + out;
    n /= base;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = BigInt(0);
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * BigInt(58) + BigInt(i);
  }
  const hex = n === BigInt(0) ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return new Uint8Array([...new Array(zeros).fill(0), ...body]);
}

/** json-stable-stringify@1.3.0 equivalent: sorted keys, no whitespace, undefined keys dropped. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export type QuoteRequest = {
  dry: boolean;
  swapType: string;
  slippageTolerance: number;
  originAsset: string;
  depositType: string;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: string;
  recipient: string;
  recipientType: string;
  deadline: string;
  quoteWaitingTimeMs?: number;
  referral?: string;
  virtualChainRecipient?: string;
  virtualChainRefundRecipient?: string;
  customRecipientMsg?: string;
  [k: string]: unknown;
};

export type Quote = {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  minAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut: string;
  timeEstimate?: number;
  depositAddress?: string;
  depositMemo?: string;
  deadline?: string;
  timeWhenInactive?: string;
  refundFee?: string;
  withdrawFee?: string;
};

export type QuoteResponse = {
  correlationId?: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
};

const x = <T,>(v: T) => (v ? v : undefined);

/** The exact string 1Click signed for this response. */
export function signedQuoteString(r: QuoteResponse): string {
  const q = r.quoteRequest;
  const o = r.quote;
  const req = {
    dry: q.dry, swapType: q.swapType, slippageTolerance: q.slippageTolerance, originAsset: q.originAsset,
    depositType: q.depositType, destinationAsset: q.destinationAsset, amount: q.amount, refundTo: q.refundTo,
    refundType: q.refundType, recipient: q.recipient, recipientType: q.recipientType, deadline: q.deadline,
    quoteWaitingTimeMs: x(q.quoteWaitingTimeMs), referral: x(q.referral), virtualChainRecipient: x(q.virtualChainRecipient),
    virtualChainRefundRecipient: x(q.virtualChainRefundRecipient), customRecipientMsg: x(q.customRecipientMsg),
  };
  const base = {
    amountIn: o.amountIn, amountInFormatted: o.amountInFormatted, amountInUsd: o.amountInUsd, minAmountIn: o.minAmountIn,
    amountOut: o.amountOut, amountOutFormatted: o.amountOutFormatted, amountOutUsd: o.amountOutUsd, minAmountOut: o.minAmountOut,
  };
  const quote = q.dry
    ? base
    : {
        ...base, depositAddress: x(o.depositAddress), depositMemo: x(o.depositMemo), deadline: x(o.deadline),
        timeWhenInactive: x(o.timeWhenInactive), timeEstimate: x(o.timeEstimate), refundFee: x(o.refundFee), withdrawFee: x(o.withdrawFee),
      };
  return stableStringify({ ...req, ...quote, timestamp: r.timestamp });
}

// DER prefix that turns a raw 32-byte ed25519 key into an SPKI public key.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export function verifyQuoteSignature(r: QuoteResponse, pubkey = ONE_CLICK_PUBKEY): boolean {
  try {
    const sig = base58Decode(r.signature.replace(/^ed25519:/, ""));
    const pk = base58Decode(pubkey.replace(/^ed25519:/, ""));
    if (sig.length !== 64 || pk.length !== 32) return false;
    const digest = createHash("sha256").update(signedQuoteString(r), "utf8").digest();
    const message = Buffer.from(base58Encode(digest), "utf8");
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk]), format: "der", type: "spki" });
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}

// Plain-English lines for vault receipts (get_receipts / trellis_vault events).

import { NEAR_DECIMALS, TOKENS, WRAP_NEAR } from "@/lib/near/config";
import { fromBase } from "@/lib/near/tx";
import type { VaultReceipt } from "@/lib/near/vault";

const META: Record<string, { s: string; d: number }> = {
  [WRAP_NEAR]: { s: "wNEAR", d: 24 },
  [TOKENS.USDC]: { s: "USDC", d: 6 },
  [TOKENS.USDT]: { s: "USDT", d: 6 },
};
const amt = (raw: string, token: string | null) => {
  const m = token ? META[token] : { s: "NEAR", d: NEAR_DECIMALS };
  if (!m) return `${raw} of ${token}`;
  const v = fromBase(raw, m.d);
  return `${v.toLocaleString("en-US", { maximumFractionDigits: v >= 1 ? 4 : 6 })} ${m.s}`;
};

export function receiptText(r: VaultReceipt): string {
  switch (r.kind) {
    case "WrapNear":
      return `Wrapped ${amt(r.amount_in, null)}`;
    case "Supply":
      return `Supplied ${amt(r.amount_in, r.token_in)} as collateral`;
    case "Repay":
      return `Repaid ${amt(r.amount_in, r.token_in)}`;
    case "Borrow":
      return `Borrowed ${amt(r.amount_out, r.token_out)}`;
    case "WithdrawCollateral":
      return `Withdrew ${amt(r.amount_out, r.token_out)} collateral`;
    case "WithdrawSupplied":
      return `Withdrew ${amt(r.amount_out, r.token_out)} supplied`;
    case "SwapRef":
      return `Swapped ${amt(r.amount_in, r.token_in)} → ${amt(r.amount_out, r.token_out)}`;
    case "RecoverRef":
      return `Recovered ${amt(r.amount_out, r.token_out)} from Ref`;
    case "IntentsRoute":
      return `Routed ${amt(r.amount_in, r.token_in)} via NEAR Intents`;
    case "IntentsWithdraw":
      return `Pulled ${amt(r.amount_out, r.token_out)} back from NEAR Intents`;
  }
}

export function receiptAgo(r: VaultReceipt, now = Date.now()): string {
  const ms = now - Number(BigInt(r.timestamp) / BigInt(1e6));
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** A receipt as a money-flow move (symbols + human amounts). */
export function receiptMove(r: VaultReceipt) {
  const side = (raw: string, token: string | null) => {
    if (!token) return { sym: undefined, n: undefined };
    const m = META[token];
    return { sym: m?.s ?? token, n: m ? fromBase(raw, m.d) : undefined };
  };
  const i = side(r.amount_in, r.token_in);
  const o = side(r.amount_out, r.token_out);
  return { id: r.op_id, kind: r.kind, tokenIn: i.sym, amountIn: i.n, tokenOut: o.sym, amountOut: o.n };
}

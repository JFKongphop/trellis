// NEAR transaction decoder (frontend-spec §4.4): NearTx[] → plain English per
// action + the view model rendered by tx-flow-viewer / tx-graph.
// Known methods are decoded (including ft_transfer_call's inner `msg`);
// unknown ones fall back to raw JSON with a warning.

import {
  BURROW,
  INTENTS,
  REF_EXCHANGE,
  TOKENS,
  TRELLIS_FACTORY,
  WRAP_NEAR,
} from "@/lib/near/config";
import { fromBase, type NearAction, type NearTx } from "@/lib/near/tx";
import type { TxStep, TxView } from "@/lib/tx-view";

const KNOWN: Record<string, { label: string; symbol?: string; decimals?: number }> = {
  [BURROW]: { label: "Rhea Lending" },
  [REF_EXCHANGE]: { label: "Ref Finance" },
  [INTENTS]: { label: "NEAR Intents" },
  [TRELLIS_FACTORY]: { label: "Trellis factory" },
  [WRAP_NEAR]: { label: "wNEAR token", symbol: "wNEAR", decimals: 24 },
  [TOKENS.USDC]: { label: "USDC token", symbol: "USDC", decimals: 6 },
  [TOKENS.USDT]: { label: "USDT token", symbol: "USDT", decimals: 6 },
  [TOKENS["USDC.e"]]: { label: "USDC.e token", symbol: "USDC.e", decimals: 6 },
  [TOKENS["USDT.e"]]: { label: "USDT.e token", symbol: "USDT.e", decimals: 6 },
};

export const contractLabel = (id: string) =>
  KNOWN[id]?.label ?? (id.endsWith(`.${TRELLIS_FACTORY}`) ? "Your Trellis vault" : id);

const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: x >= 1 ? 4 : 6 });
const near = (yocto: string) => `${n(fromBase(yocto, 24))} NEAR`;
function tokenAmt(token: string, raw: unknown): string {
  const k = KNOWN[token];
  if (k?.decimals !== undefined && typeof raw === "string" && /^\d+$/.test(raw)) {
    return `${n(fromBase(raw, k.decimals))} ${k.symbol}`;
  }
  return `${String(raw)} units of ${token}`;
}

export type DecodedAction = { text: string; known: boolean };

/** One action in plain English. */
export function describeAction(receiverId: string, a: NearAction): DecodedAction {
  if (a.type === "Transfer") return { text: `Send ${near(a.params.deposit)} to ${receiverId}`, known: true };
  const { methodName: m, args, deposit } = a.params;
  const to = contractLabel(receiverId);
  const ar = args as Record<string, unknown>;
  switch (m) {
    case "near_deposit":
      return { text: `Wrap ${near(deposit)} into wNEAR`, known: true };
    case "near_withdraw":
      return { text: `Unwrap ${tokenAmt(WRAP_NEAR, ar.amount)} into NEAR`, known: true };
    case "storage_deposit":
      return { text: `Register ${String(ar.account_id ?? "your account")} on ${to} (${near(deposit)}, refundable)`, known: true };
    case "ft_transfer":
      return { text: `Send ${tokenAmt(receiverId, ar.amount)} to ${String(ar.receiver_id)}`, known: true };
    case "ft_transfer_call": {
      const dest = String(ar.receiver_id);
      const amt = tokenAmt(receiverId, ar.amount);
      const msg = String(ar.msg ?? "");
      if (dest === BURROW) {
        if (msg === '"OnlyIncreaseCollateral"') return { text: `Send ${amt} to Rhea Lending as collateral`, known: true };
        if (msg === '"OnlyRepay"') return { text: `Repay ${amt} of Rhea Lending debt`, known: true };
        if (msg === "") return { text: `Supply ${amt} to Rhea Lending (not collateral)`, known: true };
      }
      if (dest === REF_EXCHANGE && msg) {
        try {
          const parsed = JSON.parse(msg) as { actions: { pool_id: number; token_out: string; min_amount_out: string }[] };
          const last = parsed.actions[parsed.actions.length - 1];
          return {
            text: `Swap ${amt} on Ref pool ${parsed.actions.map((x) => x.pool_id).join(" → ")} for at least ${tokenAmt(last.token_out, last.min_amount_out)}`,
            known: true,
          };
        } catch {
          return { text: `Send ${amt} to Ref with an unreadable message`, known: false };
        }
      }
      if (dest.endsWith(`.${TRELLIS_FACTORY}`)) return { text: `Deposit ${amt} into your Trellis vault`, known: true };
      return { text: `Send ${amt} to ${contractLabel(dest)} with message ${msg || "(empty)"}`, known: false };
    }
    case "execute":
    case "execute_with_pyth": {
      const acts = ((ar.actions as Record<string, { token_id: string; amount?: string; max_amount?: string }>[]) ?? []).map((x) => {
        const [kind, v] = Object.entries(x)[0] ?? ["?", { token_id: "?" }];
        const sym = KNOWN[v.token_id]?.symbol ?? v.token_id;
        const amt = v.amount ?? v.max_amount;
        const verb: Record<string, string> = {
          Borrow: "borrow",
          Withdraw: "withdraw",
          DecreaseCollateral: "remove collateral",
          IncreaseCollateral: "add collateral",
          Repay: "repay",
        };
        return `${verb[kind] ?? kind} ${amt ? "" : "all "}${sym}`;
      });
      return { text: `Rhea Lending: ${acts.join(", then ")}${m === "execute_with_pyth" ? " (checks oracle prices)" : ""}`, known: true };
    }
    case "create_vault":
      return { text: `Create your Trellis vault (${near(deposit)} goes into the vault)`, known: true };
    case "set_policy":
      return { text: "Save the vault's rules (policy)", known: true };
    case "set_agent":
      return { text: `Authorize ${String(ar.agent)} as the vault's agent`, known: true };
    case "register_token":
      return { text: `Let the vault hold ${KNOWN[String(ar.token)]?.symbol ?? String(ar.token)}`, known: true };
    case "setup_protocols":
      return { text: "Register the vault with Rhea Lending and Ref", known: true };
    case "pause":
      return { text: "Pause the vault's agent", known: true };
    case "unpause":
      return { text: "Resume the vault's agent", known: true };
    case "revoke_agent":
      return { text: "Revoke the vault's agent", known: true };
    case "clear_deleverage":
      return { text: "End the vault's open deleverage cycle", known: true };
    case "withdraw_ft":
      return { text: `Withdraw ${tokenAmt(String(ar.token), ar.amount)} from the vault to you`, known: true };
    case "withdraw_near":
      return { text: `Withdraw ${near(String(ar.amount))} from the vault to you`, known: true };
    case "owner_burrow":
      return { text: "Vault: close its Rhea Lending position (withdraw everything to the vault)", known: true };
    case "owner_ft_transfer_call":
      return { text: `Vault: send ${tokenAmt(String(ar.token), ar.amount)} to ${contractLabel(String(ar.receiver))} (${String(ar.msg)})`, known: true };
    default:
      return { text: `Call ${m} on ${to}`, known: false };
  }
}

/** View model for the transaction viewer: one step per action, in send order. */
export function decodeNearTxs(txs: NearTx[], signer?: string): TxView {
  const steps: TxStep[] = [];
  txs.forEach((tx, ti) => {
    const label = contractLabel(tx.receiverId);
    for (const a of tx.actions) {
      const d = describeAction(tx.receiverId, a);
      const idx = steps.length;
      const deposit = a.params.deposit;
      const fc = a.type === "FunctionCall" ? a.params : null;
      steps.push({
        index: idx,
        txIndex: ti,
        kind: a.type,
        receiverId: tx.receiverId,
        receiverLabel: label !== tx.receiverId ? label : undefined,
        method: fc?.methodName,
        args: fc?.args,
        deposit,
        depositDisplay: deposit === "0" ? "" : deposit === "1" ? "1 yocto" : near(deposit),
        gasTgas: fc ? Number(BigInt(fc.gas) / BigInt(1e12)) : undefined,
        label: d.text,
        known: d.known,
        after: idx > 0 ? idx - 1 : null,
        before: null,
      });
      if (idx > 0) steps[idx - 1].before = idx;
    }
  });
  return { signer, txCount: txs.length, steps, rawJson: JSON.stringify(txs, null, 2) };
}

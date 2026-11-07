// Trellis vault + factory: JSON types (from contracts/vault/src, ABI in
// contracts/target/near/trellis_vault/trellis_vault_abi.json), view calls,
// and owner transaction builders. Isomorphic: no secrets, reads via public RPC.
//
// Every owner method asserts exactly 1 yoctoNEAR + predecessor == owner
// (vault-spec §5.1), so these are always signed by the user's wallet.

import { view } from "@/lib/near/rpc";
import {
  BURROW,
  REF_EXCHANGE,
  TRELLIS_AGENT,
  TRELLIS_FACTORY,
} from "@/lib/near/config";
import { fc, ONE_YOCTO, transfer, type NearTx } from "@/lib/near/tx";

// ── Types (serde JSON shapes) ─────────────────────────────────────────────
/** U128 / NearToken serialize as decimal strings; u64 pool ids as numbers. */
export type VaultPolicy = {
  allowed_tokens: string[];
  allowed_ref_pools: number[];
  per_action_cap: [string, string][];
  daily_cap: [string, string][];
  max_slippage_bps: number;
  /** Intents quotes: signed amountOut within this many bps of the oracle price. */
  max_intents_spread_bps: number;
  min_health_factor_bps: number;
  deleverage_trigger_bps: number;
  emergency_floor_bps: number;
  max_price_age_sec: number;
  max_price_conf_bps: number;
  burrow_enabled: boolean;
  ref_enabled: boolean;
  intents_enabled: boolean;
  intents_quote_pubkey: string | null;
  min_near_reserve: string;
  max_storage_spend: string;
};

export type VaultTokenInfo = {
  decimals: number;
  burrow_extra_decimals: number;
  price_id: string;
  volatility_ratio_bps: number;
};

export type OpKind =
  | "WrapNear"
  | "Supply"
  | "Repay"
  | "Borrow"
  | "WithdrawCollateral"
  | "WithdrawSupplied"
  | "SwapRef"
  | "RecoverRef"
  | "IntentsRoute"
  | "IntentsWithdraw";

export type PendingOp = {
  op_id: string;
  kind: OpKind;
  state: "Started" | "Submitted";
  started_at: string;
  submitted_at: string | null;
  token_in: string | null;
  amount_in: string;
  token_out: string | null;
  reason_hash: string;
};

export type VaultStatus = {
  owner: string;
  agent: string | null;
  agent_expires_at: string | null;
  paused: boolean;
  in_flight: PendingOp | null;
  near_available: string;
  storage_spent: string;
  last_health: {
    health_factor_bps: string;
    collateral_usd_e18: string;
    debt_usd_e18: string;
    timestamp: string;
  } | null;
  day: string;
  /** Open deleverage cycle: the agent may only swap the withdrawn collateral and repay until it closes. */
  pending_deleverage?: {
    collateral_token: string;
    collateral_left: string;
    debt_token: string | null;
    repay_due: string;
    started_at: string;
  } | null;
};

export type VaultReceipt = {
  op_id: string;
  kind: OpKind;
  status: "Settled" | "Failed";
  token_in: string | null;
  amount_in: string;
  token_out: string | null;
  amount_out: string;
  health_factor_bps: string | null;
  note: string;
  reason_hash: string;
  /** ns timestamp */
  timestamp: string;
  /** Added by /api/vault/state from the worker's log (absent if the worker is unreachable). */
  origin?: "auto" | "plan";
  /** Why the worker took this action (automatic actions only). */
  why?: string;
  /** HF (bps) the worker saw just before an automatic action. */
  hf_before_bps?: string | null;
  /** Transaction that carried the action (from the worker's log). */
  tx_hash?: string;
};

// ── Views ─────────────────────────────────────────────────────────────────
export const factoryVaultOf = (owner: string) =>
  view<string>(TRELLIS_FACTORY, "get_vault", { owner });
export const factoryMinDeposit = async () =>
  (await view<string>(TRELLIS_FACTORY, "get_min_deposit")) ?? "0";
export const vaultOwner = (vaultId: string) => view<string>(vaultId, "get_owner");
export const vaultStatus = (vaultId: string) => view<VaultStatus>(vaultId, "get_status");
export const vaultPolicy = (vaultId: string) => view<VaultPolicy>(vaultId, "get_policy");
export const vaultTokens = async (vaultId: string) =>
  (await view<[string, VaultTokenInfo][]>(vaultId, "get_tokens")) ?? [];
/** Newest first (vault-spec §14). */
export const vaultReceipts = async (vaultId: string, limit = 20) =>
  (await view<VaultReceipt[]>(vaultId, "get_receipts", { from_index: 0, limit })) ?? [];
export const vaultRemainingDaily = async (vaultId: string, token: string) =>
  (await view<string>(vaultId, "remaining_daily", { token })) ?? "0";

/** "15000" bps → 1.5; u64::MAX means "no debt". */
export function hfFromBps(bps: string | number | null | undefined): number | null {
  if (bps === null || bps === undefined) return null;
  const n = BigInt(bps);
  if (n >= BigInt("18446744073709551615")) return null;
  return Number(n) / 10000;
}

// ── Owner transactions (wallet-signed) ────────────────────────────────────
const owner = (methodName: string, args: Record<string, unknown> = {}, gas = 30) =>
  fc(methodName, args, gas, ONE_YOCTO);

/** factory.create_vault, attaching the factory's minimum deposit. */
export const createVaultTx = (minDepositYocto: string): NearTx => ({
  receiverId: TRELLIS_FACTORY,
  // TODO(verify): measure gas on mainnet; batch = create + code + init(30) + callback(15).
  actions: [fc("create_vault", {}, 150, minDepositYocto)],
  label: "Create your Trellis vault",
  stepIds: ["create"],
});

/**
 * Save rules: set_policy + set_agent + register_token(s) in ONE transaction
 * (actions to one receiver run in order and are atomic), then
 * setup_protocols in a second transaction. setup_protocols reads the
 * registered tokens, and register_token finishes in a callback, so it can't
 * share the first transaction.
 * TODO(verify): wallets submit the second tx only after the first is final.
 */
export function rulesTxs(opts: {
  vaultId: string;
  policy: VaultPolicy;
  agentExpiresAtNs?: string | null;
  tokensToRegister: string[];
  needsProtocolSetup: boolean;
}): NearTx[] {
  const txs: NearTx[] = [
    {
      receiverId: opts.vaultId,
      actions: [
        owner("set_policy", { policy: opts.policy }, 20),
        owner("set_agent", { agent: TRELLIS_AGENT, expires_at: opts.agentExpiresAtNs ?? null }, 15),
        // 4 cross-contract calls (10 Tgas each) + 20 Tgas callback.
        ...opts.tokensToRegister.map((token) => owner("register_token", { token }, 90)),
      ],
      label: `Save rules, authorize ${TRELLIS_AGENT}${
        opts.tokensToRegister.length ? `, register ${opts.tokensToRegister.length} token(s)` : ""
      }`,
      stepIds: ["rules"],
    },
  ];
  if (opts.needsProtocolSetup) {
    txs.push({
      receiverId: opts.vaultId,
      actions: [owner("setup_protocols", {}, 80)],
      label: "Register the vault with Rhea Lending and Ref",
      stepIds: ["protocols"],
    });
  }
  return txs;
}

export const pauseTx = (vaultId: string, paused: boolean): NearTx => ({
  receiverId: vaultId,
  actions: [owner(paused ? "pause" : "unpause")],
  label: paused ? "Pause the agent" : "Resume the agent",
  stepIds: ["control"],
});

export const revokeTx = (vaultId: string): NearTx => ({
  receiverId: vaultId,
  actions: [owner("revoke_agent")],
  label: "Revoke the agent",
  stepIds: ["control"],
});

/** End the vault's open deleverage cycle (e.g. after repaying or adding collateral by hand). */
export const clearDeleverageTx = (vaultId: string): NearTx => ({
  receiverId: vaultId,
  actions: [owner("clear_deleverage")],
  label: "End the deleverage cycle",
  stepIds: ["control"],
});

/** Send tokens (or NEAR) from the wallet into the vault. */
export function fundTx(vaultId: string, tokenId: string, amountBase: string): NearTx {
  if (tokenId === "near") {
    return {
      receiverId: vaultId,
      actions: [transfer(amountBase)],
      label: "Send NEAR to the vault",
      stepIds: ["fund"],
    };
  }
  return {
    receiverId: tokenId,
    // ft_on_transfer accepts only tokens the vault registered (else refunded).
    actions: [fc("ft_transfer_call", { receiver_id: vaultId, amount: amountBase, msg: "" }, 60, ONE_YOCTO)],
    label: "Deposit into the vault",
    stepIds: ["fund"],
  };
}

/** Owner withdrawals of the vault's wallet balances (never depends on Burrow/Ref). */
export function withdrawBalancesTx(
  vaultId: string,
  ft: { tokenId: string; amountBase: string }[],
  nearYocto?: string,
): NearTx {
  return {
    receiverId: vaultId,
    actions: [
      ...ft.map((t) => owner("withdraw_ft", { token: t.tokenId, amount: t.amountBase }, 30)),
      ...(nearYocto && BigInt(nearYocto) > BigInt(0) ? [owner("withdraw_near", { amount: nearYocto }, 15)] : []),
    ],
    label: "Withdraw vault balances to your wallet",
    stepIds: ["withdraw"],
  };
}

/**
 * Close the vault's Rhea position (owner passthrough): optionally repay a
 * debt from the vault's own balance first, then decrease all collateral and
 * withdraw everything to the vault. Burrow amounts omitted = "all".
 */
export function closePositionTxs(
  vaultId: string,
  opts: {
    repay?: { tokenId: string; amountBase: string };
    collateralTokens: string[];
    suppliedTokens: string[];
    hasDebt: boolean;
  },
): NearTx[] {
  const txs: NearTx[] = [];
  if (opts.repay) {
    txs.push({
      receiverId: vaultId,
      actions: [
        owner(
          "owner_ft_transfer_call",
          { token: opts.repay.tokenId, receiver: BURROW, amount: opts.repay.amountBase, msg: '"OnlyRepay"' },
          120,
        ),
      ],
      label: "Repay the vault's Rhea debt from its own balance",
      stepIds: ["close"],
    });
  }
  const tokens = [...new Set([...opts.collateralTokens, ...opts.suppliedTokens])];
  const actions = [
    ...opts.collateralTokens.map((t) => ({ DecreaseCollateral: { token_id: t } })),
    ...tokens.map((t) => ({ Withdraw: { token_id: t } })),
  ];
  if (actions.length > 0) {
    txs.push({
      receiverId: vaultId,
      // with_prices when debt existed before the repay (DecreaseCollateral risk check).
      actions: [owner("owner_burrow", { actions, with_prices: opts.hasDebt }, opts.hasDebt ? 250 : 120)],
      label: "Withdraw all collateral and deposits from Rhea back to the vault",
      stepIds: ["close"],
    });
  }
  return txs;
}

/** Is the vault already registered on Burrow (setup_protocols ran)? */
export async function vaultProtocolsReady(vaultId: string): Promise<boolean> {
  const [b, r] = await Promise.all([
    view<object>(BURROW, "storage_balance_of", { account_id: vaultId }).catch(() => null),
    view<object>(REF_EXCHANGE, "storage_balance_of", { account_id: vaultId }).catch(() => null),
  ]);
  return !!b && !!r;
}

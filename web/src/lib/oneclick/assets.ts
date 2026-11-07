// Cross-chain funding through NEAR Intents 1Click (frontend-spec §4.7). Client-safe.
// Asset ids are from the live 1Click /v0/tokens list (2026-10-23). BSC / Polygon / Optimism are left out:
// 1Click currently blocks transfers under $1,000 from those chains.
import { TOKENS, WRAP_NEAR } from "@/lib/near/config";

export type AddressKind = "evm" | "btc" | "sol";

export type OriginAsset = {
  id: string;
  symbol: string;
  chain: string;
  chainLabel: string;
  decimals: number;
  addressKind: AddressKind;
  /** Minutes until the deposit address stops accepting funds (covers slow chains). */
  windowMin: number;
};

export const ORIGIN_ASSETS: OriginAsset[] = [
  { id: "nep141:btc.omft.near", symbol: "BTC", chain: "btc", chainLabel: "Bitcoin", decimals: 8, addressKind: "btc", windowMin: 180 },
  { id: "nep141:eth.omft.near", symbol: "ETH", chain: "eth", chainLabel: "Ethereum", decimals: 18, addressKind: "evm", windowMin: 60 },
  { id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", symbol: "USDC", chain: "eth", chainLabel: "Ethereum", decimals: 6, addressKind: "evm", windowMin: 60 },
  { id: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", symbol: "USDT", chain: "eth", chainLabel: "Ethereum", decimals: 6, addressKind: "evm", windowMin: 60 },
  { id: "nep141:base.omft.near", symbol: "ETH", chain: "base", chainLabel: "Base", decimals: 18, addressKind: "evm", windowMin: 60 },
  { id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", symbol: "USDC", chain: "base", chainLabel: "Base", decimals: 6, addressKind: "evm", windowMin: 60 },
  { id: "nep141:arb.omft.near", symbol: "ETH", chain: "arb", chainLabel: "Arbitrum", decimals: 18, addressKind: "evm", windowMin: 60 },
  { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", chain: "arb", chainLabel: "Arbitrum", decimals: 6, addressKind: "evm", windowMin: 60 },
  { id: "nep141:sol.omft.near", symbol: "SOL", chain: "sol", chainLabel: "Solana", decimals: 9, addressKind: "sol", windowMin: 60 },
  { id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", symbol: "USDC", chain: "sol", chainLabel: "Solana", decimals: 6, addressKind: "sol", windowMin: 60 },
];

/** What arrives on NEAR (delivered straight to the account as a NEP-141 token). */
export type DestinationAsset = { id: string; token: string; symbol: string; decimals: number };
export const DESTINATION_ASSETS: DestinationAsset[] = [
  { id: `nep141:${TOKENS.USDC}`, token: TOKENS.USDC, symbol: "USDC", decimals: 6 },
  { id: `nep141:${WRAP_NEAR}`, token: WRAP_NEAR, symbol: "wNEAR", decimals: 24 },
  { id: `nep141:${TOKENS.USDT}`, token: TOKENS.USDT, symbol: "USDT", decimals: 6 },
];

export const originLabel = (a: OriginAsset) => `${a.symbol} on ${a.chainLabel}`;

/** Basic shape check of the refund address on the origin chain (1Click validates it fully). */
export function validRefundAddress(kind: AddressKind, addr: string): boolean {
  const a = addr.trim();
  if (kind === "evm") return /^0x[0-9a-fA-F]{40}$/.test(a);
  if (kind === "sol") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  return /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a);
}

export type IntentsQuote = {
  dry: boolean;
  origin: string;
  destination: string;
  recipient: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOutFormatted: string;
  /** Seconds. */
  timeEstimate?: number;
  depositAddress?: string;
  depositMemo?: string;
  /** Deposit address stops accepting funds after this (ISO). */
  deadline?: string;
  correlationId?: string;
  /** Full signed 1Click response: keep it, 1Click asks clients to save it for disputes. */
  raw: unknown;
};

export type IntentsStatus = {
  status: "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED" | string;
  updatedAt?: string;
  amountOutFormatted?: string;
  refundedAmountFormatted?: string;
  refundReason?: string;
  originTxs: { hash: string; explorerUrl?: string }[];
  nearTxs: string[];
};

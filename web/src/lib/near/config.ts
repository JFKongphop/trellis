// NEAR network + contract config. Isomorphic (client + server): only
// NEXT_PUBLIC_* env vars are read here.

export type NearNetwork = "mainnet" | "testnet";

/** Mainnet by default. The testnet deployment brings its own Rhea/Ref copies (worker/src/testnet). */
export const NEAR_NETWORK: NearNetwork =
  process.env.NEXT_PUBLIC_NEAR_NETWORK === "testnet" ? "testnet" : "mainnet";

/**
 * Public RPC endpoints, tried in order by FailoverRpcProvider (near-frontend
 * skill): FastNEAR first, then dRPC, then the rate-limited NEAR endpoint as a
 * last resort. `NEXT_PUBLIC_NEAR_RPC_URLS` (comma-separated) overrides the list.
 * Don't add near.lava.build (HTTP 410 since 2026-10).
 */
const DEFAULT_RPC_URLS: Record<NearNetwork, string[]> = {
  mainnet: [
    "https://free.rpc.fastnear.com",
    "https://near.drpc.org",
    "https://rpc.mainnet.near.org",
  ],
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
};

export const PUBLIC_RPC_URLS: string[] = (() => {
  const override = (process.env.NEXT_PUBLIC_NEAR_RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return override.length > 0 ? override : DEFAULT_RPC_URLS[NEAR_NETWORK];
})();

/** FastNEAR REST (indexed balances). */
export const FASTNEAR_API =
  NEAR_NETWORK === "mainnet"
    ? "https://api.fastnear.com"
    : "https://test.api.fastnear.com";

// ── Protocol contracts. Mainnet by default; the testnet deployment (worker/src/testnet/setup.ts) runs
// its own copies of Rhea and Ref and sets these at build time. Never taken from user/agent input.
// Mirrors vault-spec §4 "Hardcoded" (the vault binds them at creation).
const pub = (v: string | undefined, fallback: string) => (v && v.trim()) || fallback;
export const BURROW = pub(process.env.NEXT_PUBLIC_BURROW, "contract.main.burrow.near");
export const ORACLE = pub(process.env.NEXT_PUBLIC_ORACLE, "aggregate-oracle.near");
export const REF_EXCHANGE = pub(process.env.NEXT_PUBLIC_REF_EXCHANGE, "v2.ref-finance.near");
export const WRAP_NEAR = pub(process.env.NEXT_PUBLIC_WRAP, "wrap.near");
export const INTENTS = "intents.near";

/** Well-known token account ids. Identify tokens by id, never by symbol. */
export const TOKENS = {
  wNEAR: WRAP_NEAR,
  USDC: pub(process.env.NEXT_PUBLIC_USDC, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
  USDT: "usdt.tether-token.near",
  "USDC.e": "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near",
  "USDT.e": "dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near",
} as const;

export const NATIVE_NEAR_ID = "near"; // pseudo id used for native NEAR rows
export const NEAR_DECIMALS = 24;
/** Storage price on NEAR: 1e19 yoctoNEAR per byte (0.00001 NEAR). */
export const STORAGE_YOCTO_PER_BYTE = BigInt(10) ** BigInt(19);

// The local sandbox demo (and its replay) runs on a chain nearblocks can't see: link to a local note instead.
// The testnet deployment is public, so it links to testnet.nearblocks.io.
const LOCAL_SANDBOX =
  NEAR_NETWORK !== "testnet" && (process.env.NEXT_PUBLIC_DEMO_MODE === "1" || process.env.NEXT_PUBLIC_DEMO_MODE === "replay");
const NEARBLOCKS = NEAR_NETWORK === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io";
export const explorerTxUrl = (hash: string) =>
  LOCAL_SANDBOX ? `/demo-explorer?tx=${encodeURIComponent(hash)}` : `${NEARBLOCKS}/txns/${hash}`;
export const explorerAccountUrl = (id: string) =>
  LOCAL_SANDBOX ? `/demo-explorer?account=${encodeURIComponent(id)}` : `${NEARBLOCKS}/address/${id}`;

// nearcore account-id rules (near-frontend skill, gasless-and-data.md).
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isValidAccountId = (id: string) =>
  id.length >= 2 && id.length <= 64 && ACCOUNT_RE.test(id);

// ── Trellis contracts (pass 2) ─────────────────────────────────────────────
/** Vault factory: `create_vault` (payable), `get_vault(owner)`, `get_min_deposit`. */
export const TRELLIS_FACTORY = process.env.NEXT_PUBLIC_TRELLIS_FACTORY || "trellis.near";
/** Agent account the vault authorizes with `set_agent`. */
export const TRELLIS_AGENT = process.env.NEXT_PUBLIC_TRELLIS_AGENT || "agent.trellis.near";

/**
 * Ref v2 pools Trellis may route wallet-mode swaps through (single hop only),
 * and the default vault allowlist. ref-dex-swaps skill, classic-pools.md §6.
 * 4512 is the deepest wNEAR/USDC pool. 6063 / 6416 are DEGEN_SWAP pools.
 * TODO(verify): degen pool price-sync behaviour (skill marks it unverified).
 */
export const REF_POOLS: { id: number; tokens: [string, string]; kind: "simple" | "degen"; label: string }[] =
  NEAR_NETWORK === "testnet"
    ? [{ id: Number(process.env.NEXT_PUBLIC_REF_POOL ?? 0), tokens: [WRAP_NEAR, TOKENS.USDC], kind: "simple", label: "wNEAR/USDC" }]
    : [
        { id: 4512, tokens: [WRAP_NEAR, TOKENS.USDC], kind: "simple", label: "wNEAR/USDC" },
        { id: 6063, tokens: [WRAP_NEAR, TOKENS.USDT], kind: "degen", label: "wNEAR/USDT" },
        { id: 6416, tokens: [TOKENS.USDT, TOKENS.USDC], kind: "degen", label: "USDT/USDC" },
      ];

export function poolFor(a: string, b: string, allowed?: number[]) {
  return REF_POOLS.find(
    (p) =>
      (!allowed || allowed.includes(p.id)) &&
      p.tokens.includes(a) &&
      p.tokens.includes(b) &&
      a !== b,
  );
}

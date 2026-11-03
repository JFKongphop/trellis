import "node:process";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  rpcUrl: process.env.RPC_URL ?? "https://free.rpc.fastnear.com",
  rpcFallbacks: (process.env.RPC_FALLBACK_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  agentId: process.env.AGENT_ACCOUNT_ID ?? "agent.trellis.near",
  get agentKeySeed() {
    return req("AGENT_KEY_SEED");
  },
  initialVaults: (process.env.VAULTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  port: Number(process.env.PORT ?? 8787),
  get apiToken() {
    return req("WORKER_API_TOKEN");
  },
  tickMs: Number(process.env.TICK_MS ?? 15_000),
  deleverageMarginBps: Number(process.env.DELEVERAGE_MARGIN_BPS ?? 300),
  dataDir: process.env.DATA_DIR ?? "./data",
  /// sync_position must wait ≥ 5 s after submission (vault MIN_SYNC_DELAY_NS); add margin.
  syncDelayMs: 6_500,
  /** Keep syncing a submitted borrow / withdraw this long (vault SYNC_FINAL_NS is 3 min). */
  syncFinalMs: 200_000,
  agentGasTgas: 300,
};

export const AGENT_METHODS = [
  "agent_wrap_near",
  "agent_supply",
  "agent_repay",
  "agent_borrow",
  "agent_withdraw_collateral",
  "agent_withdraw_supplied",
  "agent_swap_ref",
  "recover_ref",
  "agent_route_intents",
  "agent_intents_withdraw",
  "sync_position",
] as const;
export type AgentMethod = (typeof AGENT_METHODS)[number];

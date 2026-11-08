// "The agent goes rogue": acts as an attacker who holds the agent's access (the OutLayer wallet's API key) and
// tries moves your rules forbid. Each one is sent for real, signed in the TEE as the vault's agent, and the vault
// refuses it on-chain. The refusals go into testnet/deployment.json (the README proof table).
//   pnpm -C worker testnet:rogue
import { createHash } from "node:crypto";
import { JsonRpcProvider } from "near-api-js";
import { acct, call, proof, readDeploy, readEnv } from "./lib.ts";

const env = readEnv();
const d = readDeploy();
if (!d.agent_tee || !env.OUTLAYER_API_KEY) throw new Error("run `pnpm testnet:tee-agent` first: the attack uses the real TEE agent");
const rpc = new JsonRpcProvider({ url: process.env.TESTNET_RPC_MAIN ?? "https://near-testnet.drpc.org" }, { retries: 4, wait: 1000, backoff: 1.6 });
const E24 = 10n ** 24n;
const say = (s: string) => console.log(`▸ ${s}`);
// agent methods take a reason_hash like every real agent call (sha256 of the reasoning)
const reason = (why: string) => createHash("sha256").update(`rogue agent test: ${why}`).digest("hex");

// fresh prices first: with stale prices the vault would refuse everything for that reason instead
const root = acct(env.ROOT_ACCOUNT!, env.ROOT_KEY!);
const now = Math.floor(Date.now() / 1000);
for (const [pid, px] of [
  ["c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750", d.price_e8 ?? "500000000"],
  ["eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", "100000000"],
]) {
  await call(root, d.oracle, "set_price", { price_identifier: pid, pyth_price: { price: px, conf: "50000", expo: -8, publish_time: now } }, { tgas: 10 });
}
say(`oracle refreshed (NEAR $${(Number(d.price_e8 ?? "500000000") / 1e8).toFixed(2)})`);

type Attempt = { key: string; what: string; method: string; args: Record<string, unknown>; deposit?: string };
const attempts: Attempt[] = [
  {
    key: "rogue_owner",
    what: "rewrite its own rules (call the owner-only set_policy)",
    method: "set_policy",
    args: { policy: { ...(await rpc.callFunction({ contractId: d.vault, method: "get_policy", args: {}, blockQuery: { finality: "optimistic" } }) as object), max_slippage_bps: 5000 } },
    deposit: "1",
  },
  { key: "rogue_pool", what: "swap through a pool you never allowed (pool 1)", method: "agent_swap_ref", args: { pool_id: 1, token_in: d.usdc, token_out: d.wrap, amount_in: "1000000", reason_hash: reason("pool 1") } },
  { key: "rogue_cap", what: "swap 3 wNEAR out of the vault at once (your per-action cap is 2)", method: "agent_swap_ref", args: { pool_id: d.pool_id, token_in: d.wrap, token_out: d.usdc, amount_in: (3n * E24).toString(), reason_hash: reason("swap 3 wNEAR") } },
  { key: "rogue_borrow", what: "borrow 8 USDC, which would drop the health factor below your 1.5 floor", method: "agent_borrow", args: { token: d.usdc, amount: "8000000", reason_hash: reason("borrow 8 USDC") } },
];

for (const a of attempts) {
  if (readDeploy().proof?.[a.key]) {
    say(`already recorded: ${a.what}`);
    continue;
  }
  say(`agent tries to ${a.what}`);
  const r = await fetch(`${env.OUTLAYER_API}/wallet/v1/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OUTLAYER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ receiver_id: d.vault, method_name: a.method, args: a.args, gas: "300000000000000", deposit: a.deposit ?? "0" }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await r.json().catch(() => ({}))) as any;
  const tx: string | undefined = body.tx_hash ?? body.details?.tx_hash ?? body.transaction_hash;
  if (!tx) {
    say(`  not sent: OutLayer answered ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
    continue;
  }
  const o: any = await rpc.viewTransactionStatusWithReceipts({ txHash: tx, accountId: d.agent, waitUntil: "FINAL" });
  const failures = [o.status, ...o.receipts_outcome.map((x: any) => x.outcome.status)]
    .filter((s: any) => s && typeof s === "object" && "Failure" in s)
    .map((s: any) => JSON.stringify(s.Failure));
  // only the vault's own rule errors count; anything else (e.g. bad arguments) is a bug in this script
  const panic = failures.map((f) => f.match(/ERR_[A-Z_]+/)?.[0]).find(Boolean); // e.g. ERR_NOT_OWNER
  const events = o.receipts_outcome
    .filter((x: any) => x.outcome.executor_id === d.vault)
    .flatMap((x: any) => x.outcome.logs)
    .filter((l: string) => l.startsWith("EVENT_JSON:"))
    .map((l: string) => JSON.parse(l.slice(11)));
  const v = events.find((e: any) => e.event === "policy_violation");
  const rule = v ? `policy_violation: ${(Array.isArray(v.data) ? v.data[0] : v.data).rule}` : panic;
  if (!rule) {
    say(`  !! no rule refusal (tx ${tx}): ${failures.join(" ").slice(0, 300) || "it went through"}`);
    continue;
  }
  say(`  refused on-chain: ${rule} (tx ${tx})`);
  proof(a.key, `Rogue agent tries to ${a.what} → refused: ${rule}`, tx);
}

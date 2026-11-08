// Makes the OutLayer custody wallet (key inside the TEE) the vault's agent, after `pnpm testnet:outlayer`.
//   pnpm -C worker testnet:tee-agent
// 1. sends the wallet's NEAR account a little testnet NEAR for gas (a transfer creates an implicit account)
// 2. the vault owner calls set_agent(<that account>): from now on only TEE-signed calls pass the vault's agent check
// The old function-call-key agent stops working at that moment (the vault knows one agent).
import { actions } from "near-api-js";
import { acct, balance, call, exists, fmt, near, proof, readDeploy, readEnv, send, setDeploy } from "./lib.ts";

const env = readEnv();
const d = readDeploy();
if (!env.OUTLAYER_AGENT || !env.OUTLAYER_API_KEY) throw new Error("run `pnpm testnet:outlayer` first");
const tee = env.OUTLAYER_AGENT;
const root = acct(env.ROOT_ACCOUNT!, env.ROOT_KEY!);
const alice = acct(env.ALICE_ACCOUNT!, env.ALICE_KEY!);

if (!(await exists(tee)) || (await balance(tee)) < near("0.5")) {
  const r = await send(root, tee, [actions.transfer(near(2))]);
  proof("tee_fund", "Gas money for the TEE agent's account (it holds no vault funds)", r.tx);
}
console.log(`TEE agent ${tee}: ${fmt(await balance(tee))} NEAR`);

const current = await (await fetch(process.env.TESTNET_RPC ?? "https://test.rpc.fastnear.com", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: d.vault, method_name: "get_status", args_base64: "e30=" } }),
}).then((r) => r.json()).then((j: any) => JSON.parse(Buffer.from(j.result.result).toString())).catch(() => null));
if (current?.agent !== tee) {
  const r = await call(alice, d.vault, "set_agent", { agent: tee }, { deposit: 1n, tgas: 50 });
  proof("set_tee_agent", "Owner makes the TEE wallet the vault's only agent (key generated and held in OutLayer's TEE)", r.tx);
  console.log(`vault ${d.vault}: agent is now ${tee}`);
}
setDeploy({ agent: tee, agent_tee: { provider: "OutLayer", api: env.OUTLAYER_API, wallet_id: env.OUTLAYER_WALLET_ID }, fc_agent: d.fc_agent ?? d.agent });

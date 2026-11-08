// Creates the agent's OutLayer custody wallet on testnet: its NEAR key is generated and kept inside OutLayer's
// TEE (Intel TDX, released by NEAR MPC), so no server and no person ever holds it. Run it yourself, once:
//   pnpm -C worker testnet:outlayer
// Saves the wallet's API key to trellis/.env.testnet (git-ignored). The API key can ask the wallet to sign
// function calls; it can't read or export the key. Then `pnpm -C worker testnet:tee-agent` makes it the vault's agent.
import { readEnv, setEnv } from "./lib.ts";

const API = process.env.OUTLAYER_API ?? "https://testnet-api.outlayer.ai";
if (readEnv().OUTLAYER_API_KEY) {
  console.log(`already registered: ${readEnv().OUTLAYER_AGENT} (delete the OUTLAYER_* lines in .env.testnet to make a new one)`);
  process.exit(0);
}
const r = await fetch(`${API}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
if (!r.ok) throw new Error(`OutLayer register: ${r.status} ${await r.text()}`);
const w = (await r.json()) as { wallet_id: string; api_key?: string; near_account_id: string; handoff_url?: string };
if (!w.api_key) throw new Error("OutLayer returned no api_key");
setEnv("OUTLAYER_API", API);
setEnv("OUTLAYER_WALLET_ID", w.wallet_id);
setEnv("OUTLAYER_AGENT", w.near_account_id);
setEnv("OUTLAYER_API_KEY", w.api_key);
console.log(`OutLayer wallet ${w.wallet_id}
  agent account (key held in the TEE): ${w.near_account_id}
  API key saved to .env.testnet (not printed)
  policy dashboard: https://app.outlayer.ai/wallet (its handoff link carries the API key, so it isn't printed)`);

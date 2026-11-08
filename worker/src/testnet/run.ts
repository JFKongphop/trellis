// Runs Trellis on NEAR testnet (after `pnpm testnet:setup`):
//   1. keeps the mock oracle's prices fresh (the vault rejects prices older than 60 s)
//   2. serves a small control API (GET /state, POST /price {"nearE8"}) so the web app can "crash" NEAR
//   3. starts the Trellis worker against testnet
//   4. the first time, opens the leveraged position through an owner-approved plan
//   5. records every agent move with its testnet tx in testnet/deployment.json (the README proof table)
// Writes demo/.state.testnet.json for the web app (`pnpm demo:testnet`) and prints TESTNET_READY. Ctrl-C stops it.
//   pnpm -C worker testnet:run
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { ROOT_DIR, RPC, call, proof, readDeploy, readEnv, setDeploy } from "./lib.ts";

const NEAR_PID = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const USDC_PID = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
const START_E8 = "500000000"; // $5.00
const E24 = 10n ** 24n;
const PORTS = { worker: Number(process.env.WORKER_PORT ?? 8787), control: Number(process.env.CONTROL_PORT ?? 8788) };
const say = (s: string) => console.log(`▸ ${s}`);

const env = readEnv();
const d = readDeploy();
if (!d.vault || !env.ROOT_KEY) throw new Error("run `pnpm testnet:setup` first");
// Public testnet RPCs rate-limit busy clients (rpc.testnet.near.org is deprecated and refuses everything).
// The keeper and the worker use dRPC first and FastNEAR as the fallback, so one rate limit never lets prices go stale.
const RPCS = [process.env.TESTNET_RPC_MAIN ?? "https://near-testnet.drpc.org", RPC];
const KEEPER_RPCS = RPCS;
const keepers = KEEPER_RPCS.map(
  (url) => new Account(env.ROOT_ACCOUNT!, new JsonRpcProvider({ url }, { retries: 2, wait: 800, backoff: 1.6 }), KeyPairSigner.fromSecretKey(env.ROOT_KEY as KeyPairString)),
);

// ── 1. price keeper ──
let price = (d.price_e8 as string | undefined) ?? START_E8;
let publishing = Promise.resolve();
function publish(nearE8: string): Promise<void> {
  // one at a time: both prices share the root key's nonce
  publishing = publishing.then(async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [pid, px] of [[NEAR_PID, nearE8], [USDC_PID, "100000000"]] as const) {
      const args = { price_identifier: pid, pyth_price: { price: px, conf: "50000", expo: -8, publish_time: now } };
      let last: unknown;
      for (const k of keepers) {
        try {
          await call(k, d.oracle, "set_price", args, { tgas: 10 });
          last = null;
          break;
        } catch (e) {
          last = e;
        }
      }
      if (last) throw last;
    }
  });
  return publishing;
}
await publish(price);
setInterval(() => publish(price).catch((e) => console.error("price keeper:", (e as Error).message)), 20_000);
say(`oracle: NEAR $${(Number(price) / 1e8).toFixed(2)}, refreshed every 20 s`);

// ── 2. control API ──
http
  .createServer(async (req, res) => {
    const reply = (code: number, body: object) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/state") return reply(200, { nearE8: price });
    if (req.method === "POST" && req.url === "/price") {
      let raw = "";
      for await (const c of req) raw += c;
      const want = (() => {
        try {
          return String(JSON.parse(raw).nearE8 ?? "");
        } catch {
          return "";
        }
      })();
      if (!/^[1-9]\d{0,13}$/.test(want)) return reply(400, { error: "nearE8 must be a positive integer string" });
      price = want;
      setDeploy({ price_e8: price });
      try {
        await publish(price);
        say(`oracle: NEAR → $${(Number(price) / 1e8).toFixed(2)}`);
        return reply(200, { nearE8: price });
      } catch (e) {
        return reply(500, { error: (e as Error).message });
      }
    }
    reply(404, { error: "not found" });
  })
  .listen(PORTS.control, "127.0.0.1");

// ── 3. the worker ──
const dataDir = path.join(ROOT_DIR, "testnet", "worker-data");
fs.mkdirSync(dataDir, { recursive: true });
const workerLog = fs.openSync(path.join(dataDir, "worker.log"), "a");
const worker = spawn(path.join(ROOT_DIR, "worker/node_modules/.bin/tsx"), ["src/index.ts"], {
  cwd: path.join(ROOT_DIR, "worker"),
  env: {
    ...process.env,
    RPC_URL: RPCS[0],
    RPC_FALLBACK_URLS: RPCS.slice(1).join(","),
    AGENT_ACCOUNT_ID: d.agent,
    AGENT_KEY_SEED: env.AGENT_KEY_SEED,
    // the agent signs inside OutLayer's TEE once `testnet:tee-agent` made that wallet the vault's agent
    ...(d.agent_tee ? { OUTLAYER_API: env.OUTLAYER_API, OUTLAYER_API_KEY: env.OUTLAYER_API_KEY } : {}),
    VAULTS: d.vault,
    WORKER_API_TOKEN: env.WORKER_API_TOKEN,
    PORT: String(PORTS.worker),
    TICK_MS: "8000",
    DATA_DIR: dataDir,
  },
  stdio: ["ignore", workerLog, workerLog],
});
const stop = () => {
  worker.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
worker.on("exit", (c) => {
  console.error(`worker stopped (exit ${c}); log: ${path.join(dataDir, "worker.log")}`);
  process.exit(1);
});

const api = async (method: string, p: string, body?: object): Promise<any> => {
  const r = await fetch(`http://127.0.0.1:${PORTS.worker}${p}`, {
    method,
    headers: { authorization: `Bearer ${env.WORKER_API_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};
for (let i = 0; ; i++) {
  try {
    await fetch(`http://127.0.0.1:${PORTS.worker}/healthz`);
    break;
  } catch {
    if (i > 60) throw new Error("worker didn't start");
    await new Promise((s) => setTimeout(s, 500));
  }
}
await api("POST", "/vaults", { vaultId: d.vault, owner: d.owner });
say(`worker protecting ${d.vault} as ${d.agent}${d.agent_tee ? " (key held in OutLayer's TEE)" : ""}`);

// ── 4. leveraged position (once) ──
if (!d.position) {
  say("opening a ~1.25x leveraged wNEAR position (owner-approved plan)");
  const planId = `testnet-setup-${Date.now().toString(36)}`;
  await api("POST", "/plans", {
    planId,
    vaultId: d.vault,
    owner: d.owner,
    reasoning: "Open a ~1.25x leveraged wNEAR position",
    steps: [
      { method: "agent_supply", args: { token: d.wrap, amount: (2n * E24).toString() }, label: "Supply 2 wNEAR as collateral" },
      { method: "agent_borrow", args: { token: d.usdc, amount: "3000000" }, label: "Borrow 3 USDC" },
      { method: "agent_swap_ref", args: { pool_id: d.pool_id, token_in: d.usdc, token_out: d.wrap, amount_in: "3000000" }, label: "Swap 3 USDC → wNEAR" },
      { method: "agent_supply", args: { token: d.wrap, amount: E24.toString() }, label: "Supply 1 wNEAR as collateral" },
    ],
  });
  let st: any;
  for (let i = 0; i < 150; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    st = await api("GET", `/plans/${planId}`);
    if (st.status === "done" || st.status === "failed") break;
  }
  if (st?.status !== "done") throw new Error(`plan didn't finish: ${JSON.stringify(st)} (worker log: ${path.join(dataDir, "worker.log")})`);
  const steps = st.steps as { label: string; txHash?: string }[];
  steps.forEach((s, i) => s.txHash && proof(`position_${i + 1}`, `Agent (owner-approved plan): ${s.label}`, s.txHash));
  setDeploy({ position: true });
  say("position open");
}

// ── 5. record the agent's own moves (auto-protection) as they happen ──
setInterval(async () => {
  try {
    const { reasons } = await api("GET", `/vaults/${d.vault}/reasons`);
    const seen = new Set(Object.values(readDeploy().proof ?? {}).map((p: any) => p.tx));
    let n = Object.keys(readDeploy().proof ?? {}).filter((k) => k.startsWith("auto_")).length;
    for (const r of reasons ?? []) {
      if (r.source !== "auto_protection" || !r.txHash || seen.has(r.txHash)) continue;
      const hf = Number(r.hfBefore) > 100 ? Number(r.hfBefore) / 10_000 : Number(r.hfBefore); // the worker reports basis points
      proof(`auto_${++n}`, `Agent, on its own (health factor ${hf.toFixed(2)}): ${r.why}`, r.txHash);
      say(`agent acted on its own: ${r.why} (${r.txHash})`);
    }
  } catch {
    /* worker busy */
  }
}, 10_000);

// ── state for the web app (demo mode, signing as the demo user on testnet) ──
const state = {
  rpcUrl: RPCS[0],
  rpcUrls: RPCS,
  network: "testnet",
  accountId: d.owner,
  secretKey: env.ALICE_KEY,
  factory: d.factory,
  agent: d.agent,
  vault: d.vault,
  workerUrl: `http://127.0.0.1:${PORTS.worker}`,
  workerToken: env.WORKER_API_TOKEN,
  controlUrl: `http://127.0.0.1:${PORTS.control}`,
  workerLog: path.join(dataDir, "worker.log"),
  startPriceE8: START_E8,
  contracts: { burrow: d.burrow, oracle: d.oracle, ref: d.ref, wrap: d.wrap, usdc: d.usdc, pool: d.pool_id },
};
const stateFile = path.join(ROOT_DIR, "demo", ".state.testnet.json");
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
console.log(`TESTNET_READY ${stateFile}`);
await new Promise(() => {});

#!/usr/bin/env node
// Trellis demo, free and local.
//
// `pnpm demo` (default, LIGHT): only the web app runs (about the memory of a normal `pnpm dev`).
//   It replays a recorded run of the live demo: the vault, its leveraged position, and what the
//   agent did when NEAR crashed to $1.75. No Rust, no sandbox, no worker. Nothing is signed.
//
// `pnpm demo:live` (HEAVY, needs ~4–6 GB free RAM): the real thing, locally.
//   1. builds the contracts if needed (cargo near)
//   2. starts a NEAR sandbox with real Rhea (Burrow), Ref and wNEAR code, the Trellis factory,
//      a demo user with a vault, the worker, and a leveraged position (contracts/integration-tests/tests/demo.rs)
//   3. starts the web app signing as the demo user (no wallet needed)
//
// Ctrl-C stops everything. A memory guard stops the demo above DEMO_MAX_MEM_MB (replay 3072,
// live 6144) and logs per-process memory to demo/.mem.log.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIVE = process.argv.includes("--live");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = join(ROOT, "contracts");
const STATE = join(ROOT, "demo", ".state.json");
const PORTS = { web: 3000, worker: 8787, control: 8788 };
const MEM_LOG = join(ROOT, "demo", ".mem.log");
const MEM_LIMIT_MB = Number(process.env.DEMO_MAX_MEM_MB ?? (LIVE ? 6144 : 3072));
// fewer parallel rustc processes: compiling is the most memory-hungry step
const CARGO_ENV = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" };

// declared first so an early failure can still clean up
const children = [];
let stopping = false;

const say = (s) => console.log(`\x1b[38;5;208m▸\x1b[0m ${s}`);
const fail = (s) => {
  console.error(`\x1b[31m✗ ${s}\x1b[0m`);
  cleanup(1);
};

// ── prerequisites ──────────────────────────────────────────────────────────
function need(cmd, args, hint) {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  if (r.error || r.status !== 0) fail(`${cmd} not found. ${hint}`);
}
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) fail(`Node 22+ needed (you have ${process.versions.node}).`);
need("pnpm", ["--version"], "Install pnpm: `npm i -g pnpm`");
if (LIVE) {
  need("cargo", ["--version"], "Install Rust: https://rustup.rs");
  need("cargo", ["near", "--version"], "Install cargo-near 0.22: `cargo install cargo-near --version 0.22.0 --locked`");
}

// ── contracts: rebuild when the source is newer than the wasm ──────────────
function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}
for (const [crate, wasm] of LIVE
  ? [
      ["vault", "trellis_vault"],
      ["factory", "trellis_factory"],
      ["mock-oracle", "mock_oracle"],
    ]
  : []) {
  const out = join(CONTRACTS, "target", "near", wasm, `${wasm}.wasm`);
  const src = join(CONTRACTS, crate, "src");
  if (existsSync(out) && statSync(out).mtimeMs >= newest(src)) continue;
  say(`building ${crate} contract (cargo near build)…`);
  const r = spawnSync("cargo", ["near", "build", "non-reproducible-wasm"], { cwd: join(CONTRACTS, crate), stdio: "inherit", env: CARGO_ENV });
  if (r.status !== 0) fail(`building ${crate} failed`);
}

// ── node dependencies ──────────────────────────────────────────────────────
for (const app of LIVE ? ["worker", "web"] : ["web"]) {
  if (existsSync(join(ROOT, app, "node_modules"))) continue;
  say(`installing ${app} dependencies (pnpm install)…`);
  const r = spawnSync("pnpm", ["install"], { cwd: join(ROOT, app), stdio: "inherit" });
  if (r.status !== 0) fail(`pnpm install in ${app} failed`);
}

// ── ports ──────────────────────────────────────────────────────────────────
const free = (port) =>
  new Promise((ok) => {
    const s = createServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true)));
    s.listen(port, "127.0.0.1");
  });
for (const [name, port] of Object.entries(LIVE ? PORTS : { web: PORTS.web })) {
  if (!(await free(port))) fail(`port ${port} (${name}) is busy. Stop whatever uses it and try again.`);
}
// a sandbox left over from a crashed run keeps using memory: refuse to stack another one
const stale = LIVE ? spawnSync("pgrep", ["-fl", "near-sandbox"]).stdout?.toString().trim() : "";
if (stale) fail(`a NEAR sandbox from an earlier run is still running:\n${stale}\nStop it with: pkill -f near-sandbox`);

// ── processes ──────────────────────────────────────────────────────────────
function cleanup(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM"); // whole process group (cargo → test → sandbox + worker)
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 800);
}
process.on("SIGINT", () => {
  console.log("\nstopping the demo…");
  cleanup(0);
});
process.on("SIGTERM", () => cleanup(0));
// if this script dies any other way, still take the sandbox, worker and web app down with it
process.on("exit", () => {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

// ── memory guard ───────────────────────────────────────────────────────────
// Sums the resident memory of every process in the demo's process groups (cargo, the test binary,
// near-sandbox, the worker, Next.js) and stops everything above MEM_LIMIT_MB.
writeFileSync(MEM_LOG, `# time  total_MB  top processes (MB)\n`);
let peakMb = 0;
const memTimer = setInterval(() => {
  if (stopping || children.length === 0) return;
  const groups = new Set(children.map((c) => String(c.pid)));
  const ps = spawnSync("ps", ["-A", "-o", "pgid=,rss=,comm="]).stdout?.toString() ?? "";
  let total = 0;
  const procs = [];
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || !groups.has(m[1])) continue;
    const mb = Number(m[2]) / 1024;
    total += mb;
    procs.push([m[3].split("/").pop(), mb]);
  }
  procs.sort((a, b) => b[1] - a[1]);
  const top = procs.slice(0, 4).map(([n, mb]) => `${n}=${Math.round(mb)}`).join(" ");
  peakMb = Math.max(peakMb, total);
  appendFileSync(MEM_LOG, `${new Date().toISOString().slice(11, 19)}  ${Math.round(total)}  ${top}\n`);
  if (total > MEM_LIMIT_MB) {
    fail(`stopped to protect your computer: the demo used ${(total / 1024).toFixed(1)} GB (limit ${(MEM_LIMIT_MB / 1024).toFixed(1)} GB). Biggest: ${top}. See demo/.mem.log`);
  }
}, 2000);
memTimer.unref();

if (!LIVE) {
  startWeb(null);
} else {
rmSync(STATE, { force: true });
say("starting the NEAR sandbox (first run downloads Rhea/Ref code from mainnet; 1–3 minutes)…");
const launcher = spawn(
  "cargo",
  ["test", "-p", "integration-tests", "--test", "demo", "--", "--ignored", "--nocapture"],
  {
    cwd: CONTRACTS,
    detached: true,
    env: { ...CARGO_ENV, DEMO_STATE_FILE: STATE, DEMO_WORKER_PORT: String(PORTS.worker), DEMO_CONTROL_PORT: String(PORTS.control) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
children.push(launcher);
const tail = [];
let ready = false;
const onLine = (line) => {
  tail.push(line);
  if (tail.length > 60) tail.shift();
  const step = line.match(/^DEMO_STEP (.*)/);
  if (step) say(step[1]);
  const done = line.match(/^DEMO_READY (.*)/);
  if (done && !ready) {
    ready = true;
    startWeb();
  }
};
for (const stream of [launcher.stdout, launcher.stderr]) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
}
launcher.on("exit", (code) => {
  if (stopping) return;
  console.error(tail.filter((l) => !/Tgas|^\s*$/.test(l)).slice(-30).join("\n"));
  fail(`the sandbox launcher stopped (exit ${code})${ready ? "" : " before the demo was ready"}.`);
});
}

function startWeb() {
  const s = LIVE ? JSON.parse(readFileSync(STATE, "utf8")) : null;
  say(LIVE ? "sandbox ready. Starting the web app…" : "starting the web app (replay demo, light mode)…");
  const env = s
    ? {
        DEMO_MODE: "1",
        NEXT_PUBLIC_DEMO_MODE: "1",
        DEMO_STATE_FILE: STATE,
        NEXT_PUBLIC_NEAR_RPC_URLS: s.rpcUrl,
        NEXT_PUBLIC_TRELLIS_FACTORY: s.factory,
        NEXT_PUBLIC_TRELLIS_AGENT: s.agent,
        WORKER_URL: s.workerUrl,
        WORKER_API_TOKEN: s.workerToken,
      }
    : {
        DEMO_MODE: "replay",
        NEXT_PUBLIC_DEMO_MODE: "replay",
        NEXT_PUBLIC_TRELLIS_FACTORY: "trellis.test.near",
        NEXT_PUBLIC_TRELLIS_AGENT: "agent.test.near",
      };
  const web = spawn("pnpm", ["dev", "--port", String(PORTS.web)], {
    cwd: join(ROOT, "web"),
    detached: true,
    // cap the Next.js server's JS heap
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  let shown = false;
  web.stdout.on("data", (d) => {
    if (!shown && /Ready/.test(String(d))) {
      shown = true;
      if (!s) {
        console.log(`
\x1b[1mTrellis demo (replay) is running\x1b[0m  →  \x1b[4mhttp://localhost:${PORTS.web}/vault\x1b[0m

  A replay of a recorded run of the live demo. You are alice.test.near; your vault holds a
  ~1.25x leveraged wNEAR position (30 wNEAR collateral, 30 USDC debt).

  Try:  Vault page → "Crash NEAR to $1.75": the agent's three protective moves play back (⚡),
        then the Feed page. Nothing is signed in the replay.
  For the real thing on a local NEAR sandbox: pnpm demo:live (needs ~4–6 GB free memory).

  Memory log: demo/.mem.log (stops itself above ${(MEM_LIMIT_MB / 1024).toFixed(1)} GB)
  Ctrl-C to stop.
`);
        return;
      }
      console.log(`
\x1b[1mTrellis demo is running\x1b[0m  →  \x1b[4mhttp://localhost:${PORTS.web}/vault\x1b[0m

  You are ${s.accountId}. Your vault ${s.vault} holds a ~1.25x leveraged wNEAR position
  (30 wNEAR collateral, 30 USDC debt) and the Trellis agent is watching it.

  Try:  Vault page → "Crash NEAR to $1.75" and watch the agent deleverage on its own (⚡),
        then the Feed page. Owner controls (pause, rules, withdraw) sign as the demo user.
  Chat needs a NEAR AI key in web/.env.local (NEARAI_API_KEY); everything else works without it.

  Worker log: ${s.workerLog}
  Memory log: demo/.mem.log (the demo stops itself above ${(MEM_LIMIT_MB / 1024).toFixed(1)} GB)
  Ctrl-C to stop.
`);
    }
  });
  web.stderr.on("data", (d) => process.stderr.write(d));
  web.on("exit", (code) => {
    if (!stopping) fail(`the web app stopped (exit ${code}).`);
  });
}

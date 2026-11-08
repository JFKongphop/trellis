// Deploys Trellis on NEAR testnet, with free faucet NEAR. Safe to run again: every step is skipped when done.
//   pnpm -C worker testnet:setup
//
// Rhea (Burrow) on testnet is an old version with a dead oracle, so this deploys our own copies:
//   usdc.<root>    mock USDC (6 decimals; Circle has no USDC on NEAR testnet)
//   oracle.<root>  mock price oracle (same interface as aggregate-oracle.near); prices are ours
//   ref.<root>     Ref v2 — the REAL mainnet code (downloaded from v2.ref-finance.near), one wNEAR/USDC pool
//   burrow.<root>  Rhea Lending — the REAL mainnet code (contract.main.burrow.near) with its live mainnet settings
//   app.<root>     the Trellis factory, bound to the contracts above (fixed at init)
//   agent.<root>   the agent account (one function-call key per vault)
// wNEAR is the real wrap.testnet. Then a demo user (alice-…testnet) creates a vault through the factory and sets rules.
// Every amount is 1/10 of the sandbox demo (same prices, same health factors).
// Secrets → trellis/.env.testnet (git-ignored). Public ids + proof txs → trellis/testnet/deployment.json.
import fs from "node:fs";
import path from "node:path";
import { JsonRpcProvider, KeyPair, PublicKey, actions } from "near-api-js";
import { vaultPublicKey } from "../keys.ts";
import { AGENT_METHODS } from "../config.ts";
import { ROOT_DIR, acct, balance, call, exists, faucetAccount, fmt, near, proof, readDeploy, readEnv, send, setDeploy, setEnv, topUp, view } from "./lib.ts";

const WRAP = "wrap.testnet";
const E24 = 10n ** 24n;
const NEAR_PID = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";
const USDC_PID = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
const MAINNET = { burrow: "contract.main.burrow.near", ref: "v2.ref-finance.near", wrap: "wrap.near", usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" };
const WASM = {
  ft: path.join(ROOT_DIR, "contracts/integration-tests/res/fungible_token.wasm"),
  oracle: path.join(ROOT_DIR, "contracts/target/near/mock_oracle/mock_oracle.wasm"),
  factory: path.join(ROOT_DIR, "contracts/target/near/trellis_factory/trellis_factory.wasm"),
  vault: path.join(ROOT_DIR, "contracts/target/near/trellis_vault/trellis_vault.wasm"),
};
const POOL = { wnear: 50n * E24, usdc: 250_000_000n }; // $5.00 per NEAR
const say = (s: string) => console.log(`▸ ${s}`);

const mainnet = new JsonRpcProvider({ url: process.env.MAINNET_RPC ?? "https://free.rpc.fastnear.com" }, { retries: 4, wait: 1000, backoff: 1.6 });
const mainView = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  mainnet.callFunction({ contractId, method, args, blockQuery: { finality: "final" } }) as Promise<T>;
async function mainnetCode(id: string): Promise<Buffer> {
  const f = path.join(ROOT_DIR, "contracts/target/mainnet-cache", `${id}.wasm`);
  if (!fs.existsSync(f)) {
    const c = await mainnet.viewContractCode({ contractId: id, blockQuery: { finality: "final" } });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(c.code_base64, "base64"));
  }
  return fs.readFileSync(f);
}
for (const [k, f] of Object.entries(WASM)) if (!fs.existsSync(f)) throw new Error(`missing ${k} wasm: ${f} (build with cargo near in contracts/)`);

// ── root account + NEAR from the faucet ─────────────────────────────────
let env = readEnv();
if (!env.ROOT_ACCOUNT) {
  const id = `trellis-${Date.now().toString(36)}.testnet`;
  setEnv("ROOT_KEY", await faucetAccount(id));
  setEnv("ROOT_ACCOUNT", id);
  env = readEnv();
}
const ROOT = env.ROOT_ACCOUNT!;
const root = acct(ROOT, env.ROOT_KEY!);
const rootPk = KeyPair.fromString(env.ROOT_KEY! as any).getPublicKey();
const ids = { usdc: `usdc.${ROOT}`, oracle: `oracle.${ROOT}`, ref: `ref.${ROOT}`, burrow: `burrow.${ROOT}`, factory: `app.${ROOT}`, agent: `agent.${ROOT}` };
setDeploy({ network: "testnet", root: ROOT, wrap: WRAP, ...ids, intents: "intents.testnet (unused: Intents has no testnet)" });

async function fund(target: string, want: bigint) {
  while ((await balance(target)) < want) {
    say(`faucet → ${target} (${fmt(await balance(target))} / ${fmt(want)} NEAR)`);
    await topUp(target);
  }
}
const d0 = readDeploy();
const NEEDED = near(95); // ~33 storage for the contracts, 50 wNEAR pool liquidity, 11 for the demo user
if (!d0.funded) await fund(ROOT, NEEDED);

async function sub(id: string, amount: number) {
  if (await exists(id)) return;
  await send(root, id, [actions.createAccount(), actions.transfer(near(amount)), actions.addFullAccessKey(rootPk)]);
  say(`created ${id}`);
}
const as = (id: string) => acct(id, env.ROOT_KEY!);
const done = (k: string) => Boolean(readDeploy().steps?.[k]);
const mark = (k: string) => setDeploy({ steps: { ...(readDeploy().steps ?? {}), [k]: true } });
async function ftRegister(token: string, who: string, payer = root) {
  const bal = await view<any>(token, "storage_balance_of", { account_id: who });
  if (!bal) await call(payer, token, "storage_deposit", { account_id: who, registration_only: true }, { deposit: near("0.0125") });
}

// ── mock USDC ───────────────────────────────────────────────────────────
if (!done("usdc")) {
  await sub(ids.usdc, 2.4);
  await send(as(ids.usdc), ids.usdc, [actions.deployContract(fs.readFileSync(WASM.ft))]);
  await call(as(ids.usdc), ids.usdc, "new", {
    owner_id: ROOT, total_supply: "1000000000000",
    metadata: { spec: "ft-1.0.0", name: "Mock USDC (Trellis testnet)", symbol: "USDC", decimals: 6 },
  });
  mark("usdc");
  say("mock USDC deployed: 1,000,000 USDC to the root account");
}

// ── mock oracle ─────────────────────────────────────────────────────────
if (!done("oracle")) {
  await sub(ids.oracle, 1.8);
  await send(as(ids.oracle), ids.oracle, [actions.deployContract(fs.readFileSync(WASM.oracle))]);
  await call(as(ids.oracle), ids.oracle, "new", { owner: ROOT });
  mark("oracle");
  say("mock oracle deployed");
}
async function publish(nearE8: string) {
  const now = Math.floor(Date.now() / 1000);
  for (const [pid, px] of [[NEAR_PID, nearE8], [USDC_PID, "100000000"]]) {
    await call(root, ids.oracle, "set_price", { price_identifier: pid, pyth_price: { price: px, conf: "50000", expo: -8, publish_time: now } });
  }
}
await publish("500000000");

// ── Ref v2 (real mainnet code) + wNEAR/USDC pool ────────────────────────
if (!done("ref")) {
  await sub(ids.ref, 9.6);
  say("deploying Ref v2 (mainnet code)");
  await send(as(ids.ref), ids.ref, [actions.deployContract(await mainnetCode(MAINNET.ref))]);
  await call(as(ids.ref), ids.ref, "new", { owner_id: ROOT, boost_farm_id: `boostfarm.${ROOT}`, burrowland_id: ids.burrow, exchange_fee: 2000, referral_fee: 0 });
  mark("ref");
}
if (!done("pool")) {
  await call(root, ids.ref, "storage_deposit", {}, { deposit: near(1) });
  await call(root, ids.ref, "extend_whitelisted_tokens", { tokens: [WRAP, ids.usdc] }, { deposit: 1n });
  const { value: poolId } = await call(root, ids.ref, "add_simple_pool", { tokens: [WRAP, ids.usdc], fee: 30 }, { deposit: near("0.1") });
  setDeploy({ pool_id: poolId });
  for (const t of [WRAP, ids.usdc]) await ftRegister(t, ids.ref);
  await ftRegister(WRAP, ROOT);
  await call(root, WRAP, "near_deposit", {}, { deposit: POOL.wnear });
  for (const [t, amt] of [[WRAP, POOL.wnear], [ids.usdc, POOL.usdc]] as const) {
    await call(root, t, "ft_transfer_call", { receiver_id: ids.ref, amount: amt.toString(), msg: "" }, { deposit: 1n });
  }
  await call(root, ids.ref, "add_liquidity", { pool_id: poolId, amounts: [POOL.wnear.toString(), POOL.usdc.toString()] }, { deposit: near("0.1") });
  mark("pool");
  say(`Ref pool ${poolId}: 50 wNEAR / 250 USDC ($5.00 per NEAR)`);
}
const POOL_ID = readDeploy().pool_id as number;

// ── Rhea Lending / Burrow (real mainnet code, live mainnet settings) ────
if (!done("burrow")) {
  await sub(ids.burrow, 11.4);
  say("deploying Rhea Lending (mainnet code)");
  await send(as(ids.burrow), ids.burrow, [actions.deployContract(await mainnetCode(MAINNET.burrow))]);
  const config = await mainView<any>(MAINNET.burrow, "get_config");
  Object.assign(config, { owner_id: ROOT, pyth_oracle_account_id: ids.oracle, ref_exchange_id: ids.ref, pause_operator_id: null });
  await call(as(ids.burrow), ids.burrow, "new", { config }, { tgas: 300 });
  mark("burrow");
}
if (!done("burrow_assets")) {
  for (const [mainId, tok] of [[MAINNET.wrap, WRAP], [MAINNET.usdc, ids.usdc]] as const) {
    const asset = await mainView<any>(MAINNET.burrow, "get_asset", { token_id: mainId });
    const cfg = { ...asset.config, beneficiaries: {} };
    await call(root, ids.burrow, "add_asset", { token_id: tok, asset_config: cfg }, { deposit: 1n, tgas: 300 });
    const pyth = await mainView<any>(MAINNET.burrow, "get_token_pyth_info", { token_id: mainId });
    await call(root, ids.burrow, "add_token_pyth_info", { token_id: tok, token_pyth_info: pyth }, { deposit: 1n });
    await ftRegister(tok, ids.burrow);
  }
  await call(root, ids.burrow, "storage_deposit", {}, { deposit: near("0.25") });
  // 10,000 mock USDC of borrowable liquidity
  await call(root, ids.usdc, "ft_transfer_call", { receiver_id: ids.burrow, amount: "10000000000", msg: "" }, { deposit: 1n, tgas: 150 });
  mark("burrow_assets");
  say("Rhea Lending: wNEAR + USDC markets, 10,000 USDC to borrow");
}

// ── Trellis factory (Local code mode), bound to these contracts ─────────
if (!done("factory")) {
  await sub(ids.factory, 6.5);
  await send(as(ids.factory), ids.factory, [actions.deployContract(fs.readFileSync(WASM.factory))]);
  const protocols = { burrow: ids.burrow, ref_exchange: ids.ref, oracle: ids.oracle, intents: "intents.testnet", wrap: WRAP };
  const r = await call(as(ids.factory), ids.factory, "new", { admin: ROOT, mode: "Local", protocols });
  proof("factory", "Trellis factory deployed, bound to Rhea, Ref and the oracle", r.tx);
  const c = await call(root, ids.factory, "set_code", new Uint8Array(fs.readFileSync(WASM.vault)), { tgas: 300 });
  proof("vault_code", "Vault code stored in the factory (398 KB)", c.tx);
  mark("factory");
  say(`factory ${ids.factory} ready`);
}

// ── agent account ───────────────────────────────────────────────────────
if (!done("agent")) {
  await sub(ids.agent, 1.5);
  mark("agent");
}
if (!env.AGENT_KEY_SEED) setEnv("AGENT_KEY_SEED", Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"));
if (!env.WORKER_API_TOKEN) setEnv("WORKER_API_TOKEN", Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url"));
env = readEnv();
setDeploy({ funded: true });

// ── demo user + vault through the factory ───────────────────────────────
if (!env.ALICE_ACCOUNT) {
  // a separate top-level account, made by the `testnet` registrar and funded by root (the faucet rate-limits)
  const id = `alice-trellis-${Date.now().toString(36)}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  setEnv("ALICE_KEY", kp.toString());
  await call(root, "testnet", "create_account", { new_account_id: id, new_public_key: kp.getPublicKey().toString() }, { deposit: near(11) });
  setEnv("ALICE_ACCOUNT", id);
  env = readEnv();
  say(`demo user ${id} (11 NEAR)`);
}
const ALICE = env.ALICE_ACCOUNT!;
const alice = acct(ALICE, env.ALICE_KEY!);
setDeploy({ owner: ALICE });

if (!readDeploy().vault) {
  const min = await view<string>(ids.factory, "get_min_deposit");
  const dep = BigInt(min) + near("0.5");
  const r = await call(alice, ids.factory, "create_vault", {}, { deposit: dep, tgas: 300 });
  if (!r.value) throw new Error(`create_vault returned ${JSON.stringify(r.value)} (tx ${r.tx})`);
  setDeploy({ vault: r.value });
  proof("create_vault", `Vault created through the factory (${fmt(dep)} NEAR deposit, no access keys)`, r.tx);
  say(`vault ${r.value}`);
}
const VAULT = readDeploy().vault as string;
const owner = (method: string, args: Record<string, unknown>) => call(alice, VAULT, method, args, { deposit: 1n, tgas: 300 });

if (!done("rules")) {
  const policy = {
    allowed_tokens: [WRAP, ids.usdc],
    allowed_ref_pools: [POOL_ID],
    per_action_cap: [[WRAP, (2n * E24).toString()], [ids.usdc, "10000000"]],
    daily_cap: [[WRAP, (5n * E24).toString()], [ids.usdc, "30000000"]],
    max_slippage_bps: 200,
    max_intents_spread_bps: 50,
    min_health_factor_bps: 15000,
    deleverage_trigger_bps: 13000,
    emergency_floor_bps: 11000,
    max_price_age_sec: 60,
    max_price_conf_bps: 100,
    burrow_enabled: true,
    ref_enabled: true,
    intents_enabled: false,
    intents_quote_pubkey: null,
    min_near_reserve: near("0.5").toString(),
    max_storage_spend: near(2).toString(),
  };
  proof("set_policy", "Owner signs the rules once (caps, min health factor 1.5, deleverage below 1.3)", (await owner("set_policy", { policy })).tx);
  proof("set_agent", "Owner authorizes the agent", (await owner("set_agent", { agent: ids.agent })).tx);
  for (const t of [WRAP, ids.usdc]) {
    const r = await owner("register_token", { token: t });
    if (r.value !== true) throw new Error(`register_token ${t} returned ${r.value} (tx ${r.tx})`);
  }
  await owner("setup_protocols", {});
  mark("rules");
  say("rules set, tokens registered, agent authorized");
}

// the agent's function-call key for this vault (agent_* methods only, no deposits)
if (!done("agent_key")) {
  const pk = vaultPublicKey(env.AGENT_KEY_SEED!, VAULT);
  await send(as(ids.agent), ids.agent, [actions.addFunctionCallAccessKey(PublicKey.fromString(pk), VAULT, [...AGENT_METHODS], near(1))]);
  mark("agent_key");
  say("agent key added (function-call only, this vault, agent_* methods)");
}

// alice funds the vault with 2.5 wNEAR and keeps 10 USDC for wallet mode
if (!done("deposit")) {
  await ftRegister(WRAP, ALICE, alice);
  await ftRegister(ids.usdc, ALICE);
  await call(alice, WRAP, "near_deposit", {}, { deposit: near("2.6") });
  const r = await call(alice, WRAP, "ft_transfer_call", { receiver_id: VAULT, amount: (25n * E24 / 10n).toString(), msg: "" }, { deposit: 1n });
  proof("deposit", "Owner deposits 2.5 wNEAR into the vault", r.tx);
  await call(root, ids.usdc, "ft_transfer", { receiver_id: ALICE, amount: "10000000" }, { deposit: 1n });
  mark("deposit");
}

console.log(`
Trellis is deployed on NEAR testnet
  factory  ${ids.factory}
  vault    ${VAULT}  (owner ${ALICE})
  agent    ${ids.agent}
  Rhea     ${ids.burrow}   Ref ${ids.ref} (pool ${POOL_ID})   oracle ${ids.oracle}   USDC ${ids.usdc}
  root     ${ROOT}: ${fmt(await balance(ROOT))} NEAR left
Next: pnpm -C worker testnet:run   (worker + price keeper; opens the leveraged position)
`);

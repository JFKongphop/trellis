// Shared helpers for the Trellis testnet deployment (setup, price keeper). Testnet only.
// Secrets (account keys) live in trellis/.env.testnet (git-ignored); public ids and tx hashes in testnet/deployment.json.
import fs from "node:fs";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, getTransactionLastResult, nearToYocto, type KeyPairString } from "near-api-js";

export const ROOT_DIR = path.resolve(import.meta.dirname, "../../..");
export const ENV_FILE = path.join(ROOT_DIR, ".env.testnet");
export const DEPLOY_FILE = path.join(ROOT_DIR, "testnet", "deployment.json");
export const RPC = process.env.TESTNET_RPC ?? "https://test.rpc.fastnear.com";
export const provider = new JsonRpcProvider({ url: RPC }, { retries: 6, wait: 1000, backoff: 1.6 });
export const TGAS = 1_000_000_000_000n;
export const near = (n: string | number) => BigInt(nearToYocto(String(n) as `${number}`));
export const fmt = (y: bigint) => (Number(y / 10n ** 21n) / 1000).toFixed(3);

// ── .env.testnet (secrets) ──
export function readEnv(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}
export function setEnv(k: string, v: string) {
  const e = readEnv();
  e[k] = v;
  fs.writeFileSync(ENV_FILE, "# Trellis testnet accounts (git-ignored). Testnet only: never put mainnet keys here.\n" + Object.entries(e).map(([a, b]) => `${a}=${b}`).join("\n") + "\n", { mode: 0o600 });
}

// ── deployment.json (public) ──
export type Deployment = Record<string, any>;
export function readDeploy(): Deployment {
  return fs.existsSync(DEPLOY_FILE) ? JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8")) : {};
}
export function setDeploy(patch: Deployment) {
  fs.mkdirSync(path.dirname(DEPLOY_FILE), { recursive: true });
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify({ ...readDeploy(), ...patch }, null, 2) + "\n");
}
/** Records a proof transaction (shown in the README table). */
export function proof(key: string, label: string, tx: string) {
  const d = readDeploy();
  setDeploy({ proof: { ...(d.proof ?? {}), [key]: { label, tx } } });
}

// ── accounts ──
export function acct(id: string, secret: string): Account {
  return new Account(id, provider, KeyPairSigner.fromSecretKey(secret as KeyPairString));
}
export async function exists(id: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId: id, blockQuery: { finality: "optimistic" } });
    return true;
  } catch {
    return false;
  }
}
export async function balance(id: string): Promise<bigint> {
  const a = await provider.viewAccount({ accountId: id, blockQuery: { finality: "optimistic" } });
  return BigInt(a.amount);
}

/** A new top-level testnet account funded by the public faucet helper. Returns its secret key. */
export async function faucetAccount(id: string): Promise<string> {
  const kp = KeyPair.fromRandom("ed25519");
  const r = await fetch("https://helper.nearprotocol.com/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`testnet faucet: ${r.status} ${await r.text()}`);
  for (let i = 0; i < 20 && !(await exists(id)); i++) await new Promise((s) => setTimeout(s, 1500));
  return kp.toString();
}

/** Moves a fresh faucet account's NEAR into `target` (the faucet account is deleted). */
export async function topUp(target: string): Promise<void> {
  const id = `trtop${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.testnet`;
  const sk = await faucetAccount(id);
  await acct(id, sk).signAndSendTransaction({ receiverId: id, actions: [actions.deleteAccount(target)], waitUntil: "FINAL" });
}

export type Sent = { tx: string; value: unknown };
/** One transaction; throws if any receipt failed. */
export async function send(from: Account, receiverId: string, acts: ReturnType<typeof actions.transfer>[]): Promise<Sent> {
  const o = await from.signAndSendTransaction({ receiverId, actions: acts, waitUntil: "FINAL", throwOnFailure: true });
  for (const r of o.receipts_outcome) {
    const st = r.outcome.status as any;
    if (st && typeof st === "object" && "Failure" in st) throw new Error(`receipt failed in ${o.transaction_outcome.id}: ${JSON.stringify(st.Failure).slice(0, 400)}`);
  }
  let value: unknown;
  try {
    value = getTransactionLastResult(o);
  } catch {
    /* empty */
  }
  return { tx: o.transaction_outcome.id, value };
}
export const call = (from: Account, contract: string, method: string, args: Record<string, unknown> | Uint8Array, opts: { deposit?: bigint; tgas?: number } = {}) =>
  send(from, contract, [actions.functionCall(method, args as any, BigInt(opts.tgas ?? 100) * TGAS, opts.deposit ?? 0n)]);
export const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction({ contractId, method, args, blockQuery: { finality: "optimistic" } }) as Promise<T>;

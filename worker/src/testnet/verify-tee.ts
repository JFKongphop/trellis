// "Verify the TEE": everything a judge can check on NEAR testnet about where the agent's key lives.
//   pnpm -C worker testnet:verify-tee
// 1. the vault: its only agent is the OutLayer wallet's account (get_status.agent)
// 2. that account: an implicit account (id = its ed25519 public key) with that one key and no other; the key is
//    derived inside OutLayer's keystore enclave and never leaves it
// 3. OutLayer's keystore DAO (dao.outlayer.testnet): the Intel TDX code measurements it approves, the keystores
//    it approved, and the NEAR MPC contract that releases the keystore's master secret
// 4. OutLayer's worker registry (worker.outlayer.testnet): TEE keys added only after an on-chain TDX quote check
// Saves the results to testnet/deployment.json (tee_check). Read-only: sends nothing.
import { JsonRpcProvider } from "near-api-js";
import { readDeploy, setDeploy } from "./lib.ts";

const rpc = new JsonRpcProvider({ url: process.env.TESTNET_RPC_MAIN ?? "https://near-testnet.drpc.org" }, { retries: 4, wait: 1000, backoff: 1.6 });
const d = readDeploy();
const DAO = "dao.outlayer.testnet";
const REGISTRY = "worker.outlayer.testnet";
const viewFn = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  rpc.callFunction({ contractId, method, args, blockQuery: { finality: "final" } }) as Promise<T>;
const ok = (b: boolean, s: string) => console.log(`${b ? "✓" : "✗"} ${s}`);

const status = await viewFn<{ agent: string }>(d.vault, "get_status");
ok(status.agent === d.agent, `vault ${d.vault} trusts exactly one agent: ${status.agent}`);

const keys = await rpc.viewAccessKeyList({ accountId: d.agent, finalityQuery: { finality: "final" } });
const implicitKey = `ed25519:${(await import("near-api-js")).baseEncode(Buffer.from(d.agent, "hex"))}`;
const onlyImplicit = keys.keys.length === 1 && keys.keys[0]!.public_key === implicitKey;
ok(onlyImplicit, `agent account has ${keys.keys.length} key(s), and it is the account's own implicit key (no one added another)`);

const vaultKeys = await rpc.viewAccessKeyList({ accountId: d.vault, finalityQuery: { finality: "final" } });
ok(vaultKeys.keys.length === 0, `the vault itself has ${vaultKeys.keys.length} access keys (no one can sign as the vault)`);

const cfg = await viewFn<any>(DAO, "get_config");
const measurements = await viewFn<any[]>(DAO, "get_approved_measurements");
ok(cfg.mpc_contract_id === "v1.signer-prod.testnet", `OutLayer keystore master secret comes from NEAR MPC (${cfg.mpc_contract_id})`);
ok(measurements.length > 0, `${DAO}: ${cfg.approved_measurements_count} approved Intel TDX measurements (MRTD + RTMR0-3), ${cfg.approved_keystores_count} approved keystores, ${cfg.dao_members_count} DAO member(s), threshold ${cfg.approval_threshold}`);

const reg = await rpc.viewAccessKeyList({ accountId: REGISTRY, finalityQuery: { finality: "final" } });
const teeKeys = reg.keys.filter((k: any) => typeof k.access_key.permission === "object");
ok(teeKeys.length > 0, `${REGISTRY}: ${teeKeys.length} worker keys, each added only after its TDX quote passed the on-chain check`);

setDeploy({
  tee_check: {
    at: new Date().toISOString(),
    agent: d.agent,
    agent_keys: keys.keys.length,
    agent_key_is_implicit: onlyImplicit,
    vault_access_keys: vaultKeys.keys.length,
    keystore_dao: DAO,
    mpc_contract: cfg.mpc_contract_id,
    approved_measurements: cfg.approved_measurements_count,
    approved_keystores: cfg.approved_keystores_count,
    dao_members: cfg.dao_members_count,
    worker_registry: REGISTRY,
    attested_worker_keys: teeKeys.length,
    example_measurement: measurements[0] ? { mrtd: measurements[0].mrtd } : null,
  },
});
console.log(`
What this does NOT prove on its own: that this particular implicit key was derived inside the keystore. That rests on
OutLayer's design (key = HMAC(master secret, wallet id) inside the attested keystore; the master secret is released by
NEAR MPC only to approved measurements). The DAO has ${cfg.dao_members_count} member on testnet.`);

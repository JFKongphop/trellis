// Prints the vault's agent public key and the near CLI command to add it as a function-call key
// on the agent account (run by the operator with the agent's full-access key; never inside the worker).
// Usage: AGENT_KEY_SEED=... pnpm provision <vault-account-id> [allowance NEAR]
import { AGENT_METHODS, config } from "../config.ts";
import { vaultPublicKey } from "../keys.ts";

const vault = process.argv[2];
const allowance = process.argv[3] ?? "1";
if (!vault) {
  console.error("usage: pnpm provision <vault-account-id> [allowance NEAR]");
  process.exit(1);
}
const pk = vaultPublicKey(config.agentKeySeed, vault);
console.log(`public key for ${vault}: ${pk}\n`);
console.log(`near account add-key ${config.agentId} grant-function-call-access \\
  --allowance '${allowance} NEAR' \\
  --contract-account-id ${vault} \\
  --function-names '${AGENT_METHODS.join(", ")}' \\
  use-manually-provided-public-key ${pk} \\
  network-config mainnet sign-with-keychain send`);

import { sessionAccount } from "@/lib/server/auth";
import { WorkerUnavailable, workerRegisterVault } from "@/lib/server/worker";
import { factoryVaultOf } from "@/lib/near/vault";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";

/** After create_vault: ask the worker to monitor the owner's vault. */
export async function POST() {
  const account = await sessionAccount();
  if (!account) return json({ error: "Sign in with your wallet first." }, 401);
  const vaultId = await factoryVaultOf(account).catch(() => null);
  if (!vaultId) return json({ error: "No vault found for this account." }, 404);
  try {
    await workerRegisterVault(vaultId, account);
    return json({ vaultId, monitored: true });
  } catch (e) {
    return json({ error: errorMessage(e), vaultId, monitored: false }, e instanceof WorkerUnavailable ? 503 : 502);
  }
}

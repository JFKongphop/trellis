import { replayEnabled, replayOwner } from "@/lib/server/demo-replay";
import { factoryMinDeposit, factoryVaultOf } from "@/lib/near/vault";
import { TRELLIS_AGENT, TRELLIS_FACTORY } from "@/lib/near/config";
import { view } from "@/lib/near/rpc";
import { json, parseAccount, errorMessage } from "../../_shared";

export const runtime = "nodejs";
// `?account=` instead of a [account] path segment: dynamic segments make Next dev start a worker process
// per request (static paths), which piled up into many GB when it failed.

/** Does this account have a vault? Also the factory's min deposit and predicted id. */
export async function GET(req: Request) {
  const owner = parseAccount(new URL(req.url).searchParams.get("account") ?? "");
  if (!owner) return json({ error: "Invalid NEAR account id" }, 400);
  if (replayEnabled()) return json(replayOwner(owner));
  try {
    const [vaultId, minDeposit, predictedId] = await Promise.all([
      factoryVaultOf(owner),
      factoryMinDeposit(),
      view<string>(TRELLIS_FACTORY, "vault_id_for", { owner }),
    ]);
    return json({ owner, vaultId, predictedId, minDeposit, factory: TRELLIS_FACTORY, agent: TRELLIS_AGENT });
  } catch (e) {
    return json({ error: `Factory read failed (${TRELLIS_FACTORY}): ${errorMessage(e)}` }, 502);
  }
}

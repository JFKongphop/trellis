// Read-only NEAR RPC access (near-api-js 7.3.1). Isomorphic: the browser gets
// the public endpoint list; the server prepends a keyed FastNEAR endpoint when
// FASTNEAR_API_KEY is set (that env var is never exposed to the client).
//
// Failover gotcha (near-api-js source): FailoverRpcProvider retries on EVERY
// error except AccountDoesNotExist, so a contract panic in a view surfaces as
// "Exceeded N providers" after all endpoints were tried. Fine for reads; never
// use this provider for sending transactions.

import { FailoverRpcProvider, JsonRpcProvider } from "near-api-js";
import { NEAR_NETWORK, PUBLIC_RPC_URLS } from "@/lib/near/config";

function rpcUrls(): string[] {
  const key =
    typeof window === "undefined" ? process.env.FASTNEAR_API_KEY : undefined;
  return key && NEAR_NETWORK === "mainnet"
    ? [`https://rpc.mainnet.fastnear.com?apiKey=${key}`, ...PUBLIC_RPC_URLS]
    : PUBLIC_RPC_URLS;
}

let _provider: FailoverRpcProvider | null = null;

export function readProvider(): FailoverRpcProvider {
  if (!_provider) {
    _provider = new FailoverRpcProvider(
      rpcUrls().map(
        (url) =>
          new JsonRpcProvider({ url }, { retries: 2, wait: 300, backoff: 1.5 }),
      ),
    );
  }
  return _provider;
}

type Json = string | number | boolean | object;

/**
 * Typed view call at `final` finality. Returns `null` when the contract returns
 * JSON null (e.g. Burrow `get_account_all_positions` for an unregistered
 * account) or nothing.
 */
export async function view<T extends Json>(
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T | null> {
  const out = await readProvider().callFunction<T>({
    contractId,
    method,
    args,
    blockQuery: { finality: "final" },
  });
  return out ?? null;
}

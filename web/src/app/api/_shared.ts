import "server-only";
import { isValidAccountId } from "@/lib/near/config";

export const json = (body: unknown, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control":
        cacheSeconds > 0
          ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`
          : "no-store",
    },
  });

/** Normalizes + validates a NEAR account id from a route param. */
export function parseAccount(raw: string): string | null {
  const id = decodeURIComponent(raw).trim().toLowerCase();
  return isValidAccountId(id) ? id : null;
}

export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

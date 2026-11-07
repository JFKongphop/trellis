import { searchTokens } from "@/lib/near/tokens";
import { json, errorMessage } from "../../_shared";

export const runtime = "nodejs";

/** GET /api/tokens/search?q=usdc → ranked candidates with account ids. */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 64);
  if (!q.trim()) return json({ error: "missing ?q=" }, 400);
  try {
    return json({ query: q, results: await searchTokens(q, 8) }, 200, 60);
  } catch (e) {
    return json({ error: `Token search failed: ${errorMessage(e)}` }, 502);
  }
}

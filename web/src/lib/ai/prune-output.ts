// Strips noise from tool outputs before they reach the agent's context:
// URL/image fields it can't use (icon/logo/img/avatar/*url) and null/undefined
// values. Keeps all substantive data (amounts, symbols, names, ids, numbers) so
// the model stays well-informed while the prompt stays lean.
//
// NOTE: in-chat cards that need those URLs must read them from a client-side
// cache (see action-plan-cache), not from the pruned tool output. Cards that
// resolve icons via an iconLookup(coinType) fallback are unaffected.

function isUrlishKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.endsWith("url") ||
    k.includes("img") ||
    k.includes("logo") ||
    k.includes("icon") ||
    k.includes("avatar")
  );
}

export function pruneForModel<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => pruneForModel(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (isUrlishKey(k)) continue;
      out[k] = pruneForModel(v);
    }
    return out as T;
  }
  return value;
}

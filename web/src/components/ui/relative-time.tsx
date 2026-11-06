"use client";

import { useNow } from "@/lib/use-now";
import { fmtRelative } from "@/lib/format";

/**
 * A relative timestamp ("12s ago") that stays live — re-renders on the shared
 * 1s tick. Isolated as its own component so only the label updates, not the
 * surrounding row.
 */
export function RelativeTime({ ms }: { ms: number }) {
  useNow();
  return <>{fmtRelative(ms)}</>;
}

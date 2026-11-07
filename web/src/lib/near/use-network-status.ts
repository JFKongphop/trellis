"use client";

import { useEffect, useState } from "react";
import { readProvider } from "@/lib/near/rpc";

/**
 * Latest final NEAR block height, polled every 3s from the public RPC list.
 * `failed` flips after three consecutive errors (the badge then goes static).
 */
export function useNearNetworkStatus() {
  const [height, setHeight] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const block = await readProvider().viewBlock({ finality: "final" });
        if (cancelled) return;
        setHeight(Number(block.header.height));
        setFailures(0);
      } catch {
        if (!cancelled) setFailures((f) => f + 1);
      }
      if (!cancelled && !document.hidden) timer = setTimeout(tick, 3000);
      else if (!cancelled) timer = setTimeout(tick, 15000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { height, ready: height != null, failed: failures >= 3 };
}

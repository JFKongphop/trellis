"use client";

import { useEffect, useState } from "react";

// One shared 1s interval drives every relative-time label on the page, so we
// don't spin up an interval per row. Subscribers re-render in lockstep.
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    for (const cb of subscribers) cb();
  }, 1000);
}

/**
 * Subscribes the caller to a shared 1s tick and returns the current epoch ms.
 * Use it to keep relative timestamps ("12s ago") live without a per-component
 * interval.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const cb = () => setNow(Date.now());
    subscribers.add(cb);
    ensureTimer();
    return () => {
      subscribers.delete(cb);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return now;
}

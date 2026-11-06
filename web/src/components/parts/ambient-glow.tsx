"use client";

import { useEffect, useRef } from "react";

type Blob = { left: number; top: number; size: number; color: string; dur: number; delay: number };

const COLORS = [
  "rgba(249,115,22,0.30)", // orange
  "rgba(139,111,199,0.28)", // violet
  "rgba(236,72,153,0.22)", // pink
  "rgba(249,115,22,0.22)",
  "rgba(139,111,199,0.20)",
];

/** Small seeded PRNG (mulberry32): same "random" layout on server and client, so no hydration mismatch. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = seeded(402);
const BLOBS: Blob[] = Array.from({ length: 10 }, (_, i) => ({
  left: rand() * 100,
  top: rand() * 100,
  size: 260 + rand() * 280,
  color: COLORS[i % COLORS.length]!,
  dur: 16 + rand() * 14,
  delay: -rand() * 12,
}));

/**
 * Ambient page glow (ported from alpha402): soft colored blobs at random positions, gently drifting,
 * plus a glow that trails the cursor. Fixed behind all content.
 */
export function AmbientGlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = { x: window.innerWidth * 0.8, y: window.innerHeight * 0.28 };
    const cur = { ...target };
    const el = ref.current;
    const apply = () => {
      el?.style.setProperty("--mx", `${cur.x}px`);
      el?.style.setProperty("--my", `${cur.y}px`);
    };
    apply();
    if (reduce) return;

    const onMove = (e: PointerEvent) => {
      target.x = e.clientX;
      target.y = e.clientY;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    let raf = 0;
    const tick = () => {
      cur.x += (target.x - cur.x) * 0.045;
      cur.y += (target.y - cur.y) * 0.045;
      apply();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className="ambient-glow" aria-hidden="true">
      {BLOBS.map((b, i) => (
        <span
          key={i}
          className="ambient-blob"
          style={{
            left: `${b.left}%`,
            top: `${b.top}%`,
            width: b.size,
            height: b.size,
            background: `radial-gradient(circle, ${b.color}, transparent 70%)`,
            animationDuration: `${b.dur}s`,
            animationDelay: `${b.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

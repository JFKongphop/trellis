"use client";

import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";

/**
 * "Agent is thinking" mark — gooey metaballs. Three accent-colored circles
 * orbit and breathe (motion/react, JS-driven), merging and splitting through an
 * inline SVG goo filter so the whole thing flows like liquid. Self-contained:
 * inline SVG filter + literal hex fills mean no CSS class / CSS-var to come up
 * empty. Reduced-motion → a static merged blob.
 *
 * Accent palette mirrors the background gradient-field shader.
 */
const GREEN = "#47d096";
const BLUE = "#328efa";
const GOLD = "#fbc768";

// Looping orbit keyframes (viewBox is 0..100, centre ~50). The paths overlap
// near the centre so the goo filter merges them, then pull apart — liquid flow.
const BALLS = [
  { fill: GREEN, cx: [38, 60, 46, 38], cy: [44, 40, 62, 44], r: [25, 22, 26, 25], dur: 3.2 },
  { fill: BLUE, cx: [62, 42, 58, 62], cy: [40, 58, 36, 40], r: [23, 26, 22, 23], dur: 3.6 },
  { fill: GOLD, cx: [50, 56, 40, 50], cy: [62, 44, 50, 62], r: [22, 24, 25, 22], dur: 2.9 },
] as const;

export function LiquidBlob({ size = 24 }: { size?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gooId = `goo-${uid}`;
  const reduced = useReducedMotion();

  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className="shrink-0 align-middle"
    >
      <defs>
        <filter id={gooId} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
          />
        </filter>
      </defs>
      <g filter={`url(#${gooId})`}>
        {BALLS.map((b, i) => (
          <motion.circle
            key={i}
            fill={b.fill}
            initial={{ cx: b.cx[0], cy: b.cy[0], r: b.r[0] }}
            animate={
              reduced
                ? { cx: b.cx[0], cy: b.cy[0], r: b.r[0] }
                : { cx: [...b.cx], cy: [...b.cy], r: [...b.r] }
            }
            transition={
              reduced
                ? undefined
                : {
                    duration: b.dur,
                    repeat: Infinity,
                    ease: "easeInOut",
                    times: [0, 0.33, 0.66, 1],
                  }
            }
          />
        ))}
      </g>
    </svg>
  );
}

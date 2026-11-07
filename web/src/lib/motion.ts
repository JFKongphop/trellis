"use client";

import type { Transition, Variants } from "motion/react";

/* ─────────────────────────────────────────────────────────
 * MOTION STORYBOARD
 *
 *    0ms   container fades in
 *  100ms   first child appears
 *  +80ms   each subsequent child (stagger)
 * spring   visualDuration 0.4, bounce 0.2
 * ─────────────────────────────────────────────────────────
 */

export const SPRING: Transition = {
  type: "spring",
  visualDuration: 0.4,
  bounce: 0.2,
};

export const SPRING_SOFT: Transition = {
  type: "spring",
  visualDuration: 0.5,
  bounce: 0.15,
};

export const SPRING_BOUNCY: Transition = {
  type: "spring",
  visualDuration: 0.55,
  bounce: 0.35,
};

export const fadeUp: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: SPRING },
};

export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.3 } },
};

export const scaleIn: Variants = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1, transition: SPRING_SOFT },
};

export const popIn: Variants = {
  initial: { opacity: 0, scale: 0.6 },
  animate: { opacity: 1, scale: 1, transition: SPRING_BOUNCY },
};

export const slideInRight: Variants = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0, transition: SPRING },
};

export const stagger = (delayChildren = 0.08, stagger = 0.06): Variants => ({
  initial: {},
  animate: {
    transition: { staggerChildren: stagger, delayChildren },
  },
});

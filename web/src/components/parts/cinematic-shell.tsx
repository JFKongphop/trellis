"use client";

import { useSetCinematicMode } from "@/components/cinematic-chrome";

type Props = {
  /** "bright" = landing hero (full-color bg). "dim" = in-app (blurred bg). */
  mode?: "bright" | "dim";
  children: React.ReactNode;
};

/**
 * Thin wrapper that sets the cinematic mode for the current page/state
 * via context. The video bg + glass header live at the root layout so
 * they survive route changes and crossfade smoothly between modes.
 */
export function CinematicShell({ mode = "dim", children }: Props) {
  useSetCinematicMode(mode);
  return <>{children}</>;
}

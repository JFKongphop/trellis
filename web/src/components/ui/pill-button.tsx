"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost";

type Props = React.ComponentProps<typeof motion.button> & {
  variant?: Variant;
};

/**
 * Standard action button. `primary` = Midnight Ink dark fill (CTAs),
 * `secondary` = whisper-gray + hairline, `ghost` = text-only. Radius is
 * the 8px button token. Default padding can be overridden via className.
 */
export function PillButton({
  variant = "primary",
  className,
  ...props
}: Props) {
  return (
    <motion.button
      whileHover={{ scale: props.disabled ? 1 : 1.03 }}
      whileTap={{ scale: props.disabled ? 1 : 0.97 }}
      transition={{ type: "spring", visualDuration: 0.2, bounce: 0.3 }}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-button px-4 py-2 text-body-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" &&
          "bg-midnight-ink text-canvas-white disabled:bg-light-taupe disabled:text-muted-ash disabled:opacity-100",
        variant === "secondary" &&
          "bg-whisper-gray text-midnight-ink ring-1 ring-hairline hover:bg-canvas-white",
        variant === "ghost" && "text-muted-ash hover:text-midnight-ink",
        className,
      )}
      {...props}
    />
  );
}

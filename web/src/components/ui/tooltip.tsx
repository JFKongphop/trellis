"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/lib/utils";

/**
 * Tooltip — a small floating label on hover/focus. Dark `surface-charcoal`
 * popup (the refero "Info Badge – Inline" recipe) with the floating shadow,
 * a pointer arrow, and a scale/fade enter+exit driven by base-ui's own
 * `data-starting-style` / `data-ending-style` hooks (no animation library).
 * Self-contained: each instance carries its own delay Provider so callers
 * don't need a global one.
 */
function Tooltip({
  delay = 200,
  children,
  ...props
}: TooltipPrimitive.Root.Props & { delay?: number }) {
  return (
    <TooltipPrimitive.Provider delay={delay}>
      <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipArrowSvg() {
  return (
    <svg
      width="12"
      height="6"
      viewBox="0 0 12 6"
      fill="none"
      aria-hidden
      className="block"
    >
      <path d="M0 0L6 6L12 0Z" className="fill-surface-charcoal" />
    </svg>
  );
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 7,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className="z-50">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "surface-charcoal rounded-card px-2.5 py-1.5 text-caption shadow-header outline-none",
            "origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 ease-out",
            "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:duration-100",
            className,
          )}
          {...props}
        >
          <TooltipPrimitive.Arrow
            className={cn(
              "data-[side=top]:-bottom-1.5",
              "data-[side=bottom]:-top-1.5 data-[side=bottom]:rotate-180",
              "data-[side=left]:-right-2 data-[side=left]:-rotate-90",
              "data-[side=right]:-left-2 data-[side=right]:rotate-90",
            )}
          >
            <TooltipArrowSvg />
          </TooltipPrimitive.Arrow>
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent };

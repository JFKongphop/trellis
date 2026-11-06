import { Grid2x2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The small Trellis corner mark stamped on a vault/position icon.
 * Place inside a `relative` parent (e.g. wrapping an <AssetIcon/>).
 */
export function BrandBadge({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -bottom-1 -right-1 inline-flex size-4 items-center justify-center rounded-full bg-midnight-ink text-canvas-white",
        className,
      )}
    >
      <Grid2x2 className="size-2.5 rotate-45" strokeWidth={2.6} />
    </span>
  );
}

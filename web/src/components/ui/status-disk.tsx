import { cn } from "@/lib/utils";

type Tone = "green" | "gold" | "red" | "neutral";

/**
 * A circular icon container for status/activity rows (deposit, redeem,
 * pending, ready). `wash` = tinted background (default); `solid` = filled.
 * Pass the lucide icon as children. Size defaults to `size-9`; override
 * via `className` (e.g. `size-5`).
 */
export function StatusDisk({
  tone = "neutral",
  solid = false,
  className,
  children,
}: {
  tone?: Tone;
  solid?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full",
        !solid && tone === "green" && "bg-deliver-green/15 text-midnight-ink",
        !solid && tone === "gold" && "bg-warning/15 text-warning",
        !solid && tone === "red" && "bg-destructive/15 text-destructive",
        !solid && tone === "neutral" && "bg-whisper-gray text-midnight-ink",
        solid && tone === "green" && "bg-deliver-green text-midnight-ink",
        solid && tone === "gold" && "bg-warning text-midnight-ink",
        solid && tone === "red" && "bg-destructive text-canvas-white",
        solid && tone === "neutral" && "bg-midnight-ink text-canvas-white",
        className,
      )}
    >
      {children}
    </span>
  );
}

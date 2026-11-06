import { cn } from "@/lib/utils";

type Tone = "neutral" | "green" | "gold" | "red" | "violet";

/**
 * Small inline label/status chip (APY, "Ready/Pending", token symbol).
 * 12px radius, uppercase micro-text. Tones map to the pillar accents as
 * tints with legible text. Reserve `font-medium` for callers that need
 * a key accent — default weight is medium.
 */
export function Tag({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-card px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider tabular-nums",
        tone === "neutral" && "bg-midnight-ink/[0.06] text-muted-ash",
        // Tinted chips use Midnight Ink text per DESIGN.md — pillar accents
        // are too low-contrast against their own tint to read as text.
        tone === "green" && "bg-deliver-green/15 text-midnight-ink",
        tone === "gold" && "bg-warning/20 text-midnight-ink",
        tone === "red" && "bg-destructive/15 text-midnight-ink",
        tone === "violet" && "bg-midnight-violet/10 text-midnight-violet",
        className,
      )}
    >
      {children}
    </span>
  );
}

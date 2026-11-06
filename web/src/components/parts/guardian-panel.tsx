"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ShieldCheck,
  AlertTriangle,
  OctagonX,
  Check,
  ChevronDown,
} from "lucide-react";
import { StatusDisk } from "@/components/ui/status-disk";
import { Tag } from "@/components/ui/tag";
import { cn } from "@/lib/utils";
import type { PlanRisk } from "@/lib/ai/plan-types";

/**
 * Reusable Guardian section — the same shield-disk header + tally tags +
 * block / "Heads up" / cleared-disclosure layout the LivePlanCard uses, but
 * driven by a plain `PlanRisk[]` ({ title, note, level }). Reused by the NEAR
 * plan card and vault-action cards (next pass) so every risk review looks the same.
 */
export function GuardianPanel({
  risks,
  className,
}: {
  risks: PlanRisk[];
  className?: string;
}) {
  const block = risks.filter((r) => r.level === "block");
  const flag = risks.filter((r) => r.level === "flag");
  const pass = risks.filter((r) => r.level === "pass");
  const blocking = block.length > 0;

  const verdict = blocking
    ? `${block.length} thing${block.length === 1 ? "" : "s"} to resolve before signing.`
    : flag.length > 0
      ? `Cleared ${pass.length} check${pass.length === 1 ? "" : "s"}. ${flag.length} to read before you sign.`
      : `Cleared all ${pass.length} check${pass.length === 1 ? "" : "s"}. Standard for this kind of order.`;

  return (
    <div data-guardian className={cn("space-y-3 border-t border-hairline/60 pt-3", className)}>
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <StatusDisk
          tone={blocking ? "red" : flag.length > 0 ? "gold" : "green"}
          solid
          className="size-7"
        >
          <ShieldCheck className="size-3.5" strokeWidth={2.6} />
        </StatusDisk>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="leading-snug">
            <div className="text-caption font-medium uppercase tracking-wider text-muted-ash">
              Guardian
            </div>
            <p className="text-body-sm text-midnight-ink">{verdict}</p>
          </div>
          <div className="flex flex-wrap gap-1">
            {block.length > 0 && <Tag tone="red">{block.length} Blocked</Tag>}
            {flag.length > 0 && <Tag tone="gold">{flag.length} Heads up</Tag>}
            {pass.length > 0 && <Tag tone="green">{pass.length} Cleared</Tag>}
          </div>
        </div>
      </div>

      {/* Block items */}
      {block.length > 0 && (
        <div className="space-y-2">
          {block.map((r, i) => (
            <div
              key={i}
              className="rounded-card bg-destructive/[0.06] px-3.5 py-3"
            >
              <div className="flex items-start gap-3">
                <StatusDisk tone="red" solid className="mt-0.5 size-8">
                  <OctagonX className="size-4" strokeWidth={2.4} />
                </StatusDisk>
                <div className="min-w-0 flex-1 leading-snug">
                  <div className="text-body font-medium text-midnight-ink">
                    {r.title}
                  </div>
                  <div className="text-body-sm text-midnight-ink/80">
                    {r.note}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Flag items */}
      {flag.length > 0 && (
        <div className="space-y-1">
          <div className="text-caption font-medium uppercase tracking-wider text-muted-ash">
            Heads up
          </div>
          <div className="divide-y divide-hairline/60">
            {flag.map((r, i) => (
              <div key={i} className="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0">
                <AlertTriangle
                  className="mt-[3px] size-3.5 shrink-0 text-warning"
                  strokeWidth={2.4}
                />
                <p className="min-w-0 flex-1 leading-snug">
                  <span className="text-body-sm font-medium text-midnight-ink">
                    {r.title}
                  </span>
                  {r.note && r.note !== r.title && (
                    <span className="text-body-sm text-muted-ash">
                      {" — "}
                      {r.note}
                    </span>
                  )}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cleared disclosure */}
      {pass.length > 0 && <ClearedDisclosure risks={pass} />}
    </div>
  );
}

function ClearedDisclosure({ risks }: { risks: PlanRisk[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 py-1.5 text-left"
        aria-expanded={open}
      >
        <Check className="size-3.5 shrink-0 text-deliver-green" strokeWidth={3} />
        <span className="min-w-0 flex-1 text-body-sm font-medium text-midnight-ink">
          {risks.length} cleared check{risks.length === 1 ? "" : "s"}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-ash transition-transform duration-200",
            open && "rotate-180",
          )}
          strokeWidth={2.4}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <ul className="space-y-1 pb-1">
              {risks.map((r, i) => (
                <li key={i} className="flex items-start gap-2.5 py-1">
                  <Check
                    className="mt-[3px] size-3.5 shrink-0 text-deliver-green"
                    strokeWidth={3}
                  />
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="text-body-sm font-medium text-midnight-ink">
                      {r.title}
                    </div>
                    <div className="text-caption text-muted-ash">{r.note}</div>
                  </div>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

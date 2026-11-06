"use client";

import { Fragment } from "react";
import { motion } from "motion/react";
import { BookOpen, AlertCircle } from "lucide-react";
import { StatusDisk } from "@/components/ui/status-disk";
import { LiquidBlob } from "@/components/parts/liquid-blob";
import { glossaryLabel } from "@/lib/ai/vault-glossary";
import { popIn } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type ExplainerState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export type ExplainerItem = {
  /** Stable React key (the tool call id). */
  id: string;
  /** Glossary key, e.g. "impermanent-loss". */
  conceptKey: string;
  state: ExplainerState;
};

/**
 * A consecutive run of `explainConcept` lookups, collapsed into one subtle
 * reference pill: a glossary glyph + the concept names. The agent already
 * quotes the full explanation inline, so this is a low-emphasis "what I
 * referenced" acknowledgement — not a per-concept stack of action cards.
 */
export function ExplainerTrail({ items }: { items: ExplainerItem[] }) {
  if (items.length === 0) return null;

  const anyActive = items.some(
    (it) => it.state === "input-streaming" || it.state === "input-available",
  );
  const allError = items.every((it) => it.state === "output-error");

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex w-fit max-w-full min-w-0 items-start gap-2.5 surface-card px-3.5 py-2 text-body-sm rounded-card"
    >
      {anyActive ? (
        <span className="mt-0.5 inline-flex shrink-0">
          <LiquidBlob size={18} />
        </span>
      ) : (
        <motion.span
          variants={popIn}
          initial="initial"
          animate="animate"
          className="mt-0.5 inline-flex shrink-0"
        >
          <StatusDisk tone={allError ? "red" : "green"} solid={allError} className="size-5">
            {allError ? (
              <AlertCircle className="size-3" strokeWidth={2.4} />
            ) : (
              <BookOpen className="size-3" strokeWidth={2.2} />
            )}
          </StatusDisk>
        </motion.span>
      )}

      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {items.map((it, i) => {
          const label = glossaryLabel(it.conceptKey);
          const isActive =
            it.state === "input-streaming" || it.state === "input-available";
          const isError = it.state === "output-error";
          return (
            <Fragment key={it.id}>
              {i > 0 && (
                <span className="text-muted-ash/40" aria-hidden>
                  ·
                </span>
              )}
              <span
                className={cn(
                  "break-words [overflow-wrap:anywhere]",
                  isActive && "shimmer-text",
                  isError && "text-destructive",
                  !isActive && !isError && "text-midnight-ink",
                )}
              >
                {isActive ? `Looking up ${label}…` : label}
              </span>
            </Fragment>
          );
        })}
      </span>
    </motion.div>
  );
}

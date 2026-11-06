"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, Sparkles } from "lucide-react";
import { LiquidBlob } from "@/components/parts/liquid-blob";

type Props = {
  text: string;
  streaming: boolean;
};

/**
 * Collapsible "Thinking…" block for AI reasoning output.
 * - Opens automatically while streaming.
 * - Auto-collapses ~700ms after streaming ends, so old reasoning blocks
 *   don't dominate the scroll once the answer has landed.
 * - User can re-expand any time.
 */
export function ThinkingTrail({ text, streaming }: Props) {
  const [open, setOpen] = useState(true);
  // Track whether the user has manually toggled — if so, respect their pref
  const userOverrode = useRef(false);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      // Just finished streaming — auto-collapse if user hasn't intervened
      if (!userOverrode.current) {
        const t = setTimeout(() => setOpen(false), 700);
        return () => clearTimeout(t);
      }
    }
    wasStreaming.current = streaming;
  }, [streaming]);

  function toggle() {
    userOverrode.current = true;
    setOpen((v) => !v);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-1.5"
    >
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-2.5 surface-card px-3.5 py-2 text-body-sm font-medium transition-opacity hover:opacity-70 rounded-card"
      >
        {streaming ? (
          <LiquidBlob size={20} />
        ) : (
          <span className="inline-flex size-5 items-center justify-center rounded-full bg-deliver-green text-midnight-ink">
            <Sparkles className="size-3" strokeWidth={2.4} />
          </span>
        )}
        <span className={streaming ? "shimmer-text" : "text-midnight-ink"}>
          {streaming ? "Thinking…" : "Reasoning"}
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ type: "spring", visualDuration: 0.2, bounce: 0.3 }}
          className="inline-flex text-muted-ash"
        >
          <ChevronDown className="size-3.5" strokeWidth={2.4} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <pre className="whitespace-pre-wrap break-words border-l-2 border-hairline surface-card px-4 py-3 font-mono text-body-sm leading-relaxed text-muted-ash">
              {text || (streaming ? "…" : "")}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

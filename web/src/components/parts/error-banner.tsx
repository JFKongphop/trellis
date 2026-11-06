"use client";

import { motion } from "motion/react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────
 * Friendly error banner for wallet / signing failures.
 * TODO(next pass): recognize NEAR-specific failures from the
 * wallet / tx outcome (NotEnoughBalance, storage not
 * registered, receipt failures) and offer a targeted fix.
 * ───────────────────────────────────────────────────────── */

type Props = {
  message: string;
  /** Optional: dispatch a follow-up message to the agent. */
  onAskAgent?: (prompt: string) => void;
  /** Optional: clear the error. */
  onDismiss?: () => void;
};

export function ErrorBanner({ message, onAskAgent, onDismiss }: Props) {
  return (
    <BannerShell
      tone="warn"
      icon={<AlertTriangle className="size-4" strokeWidth={2.4} />}
      title="Couldn't complete the action"
      body={message}
    >
      {(onAskAgent || onDismiss) && (
        <Actions>
          {onAskAgent && (
            <ActionButton
              onClick={() =>
                onAskAgent(`That failed with: "${message}". What went wrong and what should I do?`)
              }
              primary
              icon={<Sparkles className="size-3.5" strokeWidth={2.4} />}
            >
              Ask Trellis
            </ActionButton>
          )}
          {onDismiss && <ActionButton onClick={onDismiss}>Dismiss</ActionButton>}
        </Actions>
      )}
    </BannerShell>
  );
}

function BannerShell({
  tone,
  icon,
  title,
  body,
  children,
}: {
  tone: "warn" | "error";
  icon: React.ReactNode;
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", visualDuration: 0.25, bounce: 0.2 }}
      className={cn("rounded-card", 
        "space-y-2.5 p-4",
        tone === "warn" && "bg-warning/15",
        tone === "error" && "bg-destructive/12",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn("rounded-[10px]", 
            "inline-flex size-7 shrink-0 items-center justify-center",
            tone === "warn" && "bg-warning text-midnight-ink",
            tone === "error" && "bg-destructive text-canvas-white",
          )}
        >
          {icon}
        </span>
        <div className="flex-1 space-y-0.5 pt-0.5">
          <div className="text-body-sm font-medium leading-tight text-midnight-ink">
            {title}
          </div>
          {body && (
            <div className="text-body-sm text-muted-ash">{body}</div>
          )}
        </div>
      </div>
      {children}
    </motion.div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

function ActionButton({
  children,
  onClick,
  primary,
  icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("rounded-button", 
        "inline-flex items-center gap-1.5 px-3.5 py-1.5 text-body-sm font-medium transition-transform",
        "hover:scale-[1.03] active:scale-[0.97]",
        primary
          ? "bg-midnight-ink text-canvas-white"
          : "surface-panel text-midnight-ink",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

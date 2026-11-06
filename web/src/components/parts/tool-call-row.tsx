"use client";

import { motion } from "motion/react";
import { Check, AlertCircle } from "lucide-react";
import { LiquidBlob } from "@/components/parts/liquid-blob";
import { popIn } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Status = "input-streaming" | "input-available" | "output-available" | "output-error";

type Props = {
  label: string;
  status: Status;
};

export function ToolCallRow({ label, status }: Props) {
  const isWorking = status === "input-streaming" || status === "input-available";
  const isDone = status === "output-available";
  const isError = status === "output-error";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex w-fit max-w-full min-w-0 items-center gap-2.5 surface-card px-3.5 py-2 text-body-sm font-medium rounded-card"
    >
      {isWorking ? (
        <LiquidBlob size={20} />
      ) : (
        <motion.span
          variants={popIn}
          initial="initial"
          animate="animate"
          className={cn(
            "inline-flex size-5 items-center justify-center rounded-full",
            isDone && "bg-deliver-green text-midnight-ink",
            isError && "bg-destructive text-canvas-white",
          )}
        >
          {isDone ? (
            <Check className="size-3" strokeWidth={2.8} />
          ) : (
            <AlertCircle className="size-3" strokeWidth={2.4} />
          )}
        </motion.span>
      )}
      <span
        className={cn(
          "min-w-0 break-words [overflow-wrap:anywhere]",
          isWorking ? "shimmer-text" : "text-midnight-ink",
        )}
      >
        {label}
      </span>
    </motion.div>
  );
}

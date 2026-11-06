"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ShieldCheck, ArrowRight } from "lucide-react";
import { StatusDisk } from "@/components/ui/status-disk";
import { Tag } from "@/components/ui/tag";

/** Proposed vault rules (proposePolicy). Saving happens on /vault/setup with one signature. */
export function PolicyCard({
  summary,
  preset,
  link,
  errors,
}: {
  summary: string;
  preset: string;
  link: string;
  errors: string[];
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="surface-card max-w-[560px] space-y-3 p-4 rounded-card"
    >
      <div className="flex items-center gap-2.5">
        <StatusDisk tone="green" className="size-8">
          <ShieldCheck className="size-4" strokeWidth={2.4} />
        </StatusDisk>
        <div className="flex-1 text-body-sm font-medium text-midnight-ink">Proposed vault rules</div>
        <Tag tone="green">{preset}</Tag>
      </div>
      <p className="text-body-sm text-midnight-ink">{summary}</p>
      {errors.length > 0 && (
        <ul className="space-y-0.5 text-caption text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <Link
        href={link}
        className="inline-flex items-center gap-1.5 bg-midnight-ink px-4 py-2 text-body-sm font-medium text-canvas-white rounded-button"
      >
        Review and save <ArrowRight className="size-3.5" strokeWidth={2.4} />
      </Link>
    </motion.div>
  );
}

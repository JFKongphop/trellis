"use client";

import { motion } from "motion/react";
import { RotateCcw, Info } from "lucide-react";
import { computeMessageCostAndModelName } from "@/lib/ai/pricing";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export type MessageUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  model: string;
};

export type MessageMeta = {
  usage?: MessageUsage;
  durationMs?: number;
};

type Props = {
  meta?: MessageMeta;
  canRegenerate: boolean;
  onRegenerate?: () => void;
};

function fmtDuration(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** Round up to the given decimals — we want to over-report cost, never under. */
function ceilTo(usd: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.ceil(usd * f) / f;
}

function fmtCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${ceilTo(usd, 4).toFixed(4)}`;
  return `$${ceilTo(usd, 3).toFixed(3)}`;
}

/**
 * Subtle per-turn footer: duration · cost · regenerate.
 * Renders nothing if neither duration nor usage are known AND regenerate
 * isn't available — common during streaming.
 */
export function MessageFooter({ meta, canRegenerate, onRegenerate }: Props) {
  const duration = fmtDuration(meta?.durationMs);
  const costAndModelName = meta?.usage
    ? computeMessageCostAndModelName(meta.usage)
    : null;
  const cost = costAndModelName ? fmtCost(costAndModelName.cost) : null;
  const modelName = costAndModelName ? costAndModelName.name : null;
  const tokens = meta?.usage?.totalTokens;

  const hasStats = duration || cost;
  if (!hasStats && !canRegenerate) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, delay: 0.1 }}
      className="mt-1 flex items-center gap-2 text-caption tabular-nums text-muted-ash"
    >
      {duration && <span>{duration}</span>}
      {duration && cost && <span aria-hidden>·</span>}
      {cost && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="About this cost"
                className="cursor-default tabular-nums text-muted-ash transition-colors hover:text-midnight-ink"
              />
            }
          >
            <span className="text-muted-ash/60 line-through">{cost}</span>{" "}
            <span className="font-medium text-midnight-ink">Free</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-56">
            <span className="font-medium">Estimated AI Cost</span>
            <span className="block text-canvas-white/60">
              {modelName
                ? `Token usage would price at ${modelName}'s published rate, but it's free while in preview.`
                : "Token usage would price at the model's published rate, but it's free while in preview."}
            </span>
          </TooltipContent>
        </Tooltip>
      )}
      {modelName && <span aria-hidden>·</span>}
      {modelName && <span>{modelName}</span>}
      {modelName && meta?.usage && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Token usage breakdown"
                className="inline-flex size-4 items-center justify-center text-muted-ash transition-colors hover:text-midnight-ink rounded-full"
              />
            }
          >
            <Info className="size-3.5" strokeWidth={2.2} />
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-0.5 tabular-nums">
              <span>
                Input {(meta.usage.inputTokens ?? 0).toLocaleString()}
                {meta.usage.cachedInputTokens
                  ? ` (cached ${meta.usage.cachedInputTokens.toLocaleString()})`
                  : ""}
              </span>
              <span>
                Output {(meta.usage.outputTokens ?? 0).toLocaleString()}
              </span>
              {tokens ? (
                <span className="text-canvas-white/60">
                  {tokens.toLocaleString()} total
                </span>
              ) : null}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
      {canRegenerate && (
        <>
          {hasStats && <span aria-hidden>·</span>}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={onRegenerate}
                  aria-label="Regenerate response"
                  className="inline-flex size-5 items-center justify-center text-muted-ash transition-colors hover:text-midnight-ink rounded-full"
                />
              }
            >
              <RotateCcw className="size-3.5" strokeWidth={2.2} />
            </TooltipTrigger>
            <TooltipContent className="max-w-52">
              <span className="font-medium">Regenerate</span>
              <span className="block text-canvas-white/60">
                Discard this reply and re-run the agent on your last message.
              </span>
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </motion.div>
  );
}

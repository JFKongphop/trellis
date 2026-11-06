import { Send, SquareFunction, Coins, ArrowLeftRight, Landmark } from "lucide-react";
import type { TxStep } from "@/lib/tx-view";

/** Short title for a step: the method name, or "transfer". */
export const stepTitle = (s: TxStep) => (s.kind === "Transfer" ? "transfer" : (s.method ?? "call"));

/** Icon by what the step does. */
export function stepIcon(s: TxStep, cls = "size-3.5") {
  const sw = 2.4;
  if (s.kind === "Transfer") return <Send className={cls} strokeWidth={sw} />;
  const m = s.method ?? "";
  if (m.startsWith("ft_") || m.startsWith("near_") || m === "storage_deposit") return <Coins className={cls} strokeWidth={sw} />;
  if (m.includes("swap")) return <ArrowLeftRight className={cls} strokeWidth={sw} />;
  if (m.startsWith("execute") || m.includes("supply") || m.includes("borrow") || m.includes("repay")) return <Landmark className={cls} strokeWidth={sw} />;
  return <SquareFunction className={cls} strokeWidth={sw} />;
}

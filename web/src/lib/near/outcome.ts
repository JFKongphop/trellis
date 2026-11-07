// Reads a NEAR transaction outcome: a transaction can report success while a later receipt failed
// (e.g. an ft_transfer_call refund), so every receipt is checked (near-api-js.md). Shared by the
// wallet sender (browser) and the demo signer (server).
import type { FinalExecutionOutcome } from "near-api-js";

export type TxResult = { ok: boolean; hash?: string; error?: string };

function failureText(f: unknown): string {
  const s = JSON.stringify(f);
  const m = s.match(/"(?:ExecutionError|panic_msg|PanicMsg)"\s*:\s*"([^"]+)"/);
  return (m?.[1] ?? s).slice(0, 240);
}

export function outcomeResult(o: FinalExecutionOutcome): TxResult {
  const hash = o.transaction?.hash ?? o.transaction_outcome?.id;
  const top = o.status as unknown;
  if (top && typeof top === "object" && "Failure" in (top as object)) {
    return { ok: false, hash, error: failureText((top as { Failure: unknown }).Failure) };
  }
  for (const r of o.receipts_outcome ?? []) {
    const st = r.outcome.status as unknown;
    if (st && typeof st === "object" && "Failure" in (st as object)) {
      return { ok: false, hash, error: `${r.outcome.executor_id}: ${failureText((st as { Failure: unknown }).Failure)}` };
    }
  }
  return { ok: true, hash };
}


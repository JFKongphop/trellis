"use client";

// Signing NearTx[] with the connected wallet + reading outcomes. A NEAR
// transaction can report success while a later receipt failed (e.g. the
// ft_transfer_call refund), so every receipt is checked (near-api-js.md).

import { useCallback } from "react";
import { useNearWallet } from "near-connect-hooks";
import type { NearTx } from "@/lib/near/tx";
import { DEMO } from "@/lib/demo";
import { postJson } from "@/lib/near/client";

export { outcomeResult, type TxResult } from "@/lib/near/outcome";
import type { TxResult } from "@/lib/near/outcome";
import { outcomeResult } from "@/lib/near/outcome";

/** Signs and sends the given transactions in one wallet prompt (when supported). */
export function useSignTxs() {
  const { signAndSendTransactions } = useNearWallet();
  return useCallback(
    async (txs: NearTx[]): Promise<TxResult[]> => {
      if (DEMO) {
        // demo mode: the server signs as the sandbox demo account
        const { results } = await postJson<{ results: TxResult[] }>("/api/demo/send", { txs });
        return txs.map((_, i) => results[i] ?? { ok: false, error: "Not sent (an earlier transaction failed)." });
      }
      const outcomes = await signAndSendTransactions({
        transactions: txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions })),
      });
      // TODO(verify): wallets differ on whether they stop after a failed tx;
      // missing outcomes are reported as "not sent".
      return txs.map((_, i) =>
        outcomes?.[i] ? outcomeResult(outcomes[i]) : { ok: false, error: "Not sent (an earlier transaction failed or the wallet stopped)." },
      );
    },
    [signAndSendTransactions],
  );
}

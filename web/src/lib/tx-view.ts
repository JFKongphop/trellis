// View model for the transaction viewer (`tx-flow-viewer.tsx`, `tx-graph.tsx`).
// Produced by `decodeNearTxs` in `lib/near/decode.ts`: one step per NEAR action.
// NEAR transactions don't pass results between actions; steps simply run in order
// (atomic inside one transaction, not across transactions).

export type TxStepKind = "FunctionCall" | "Transfer";

export type TxStep = {
  index: number;
  /** Which transaction (0-based) this action belongs to. */
  txIndex: number;
  kind: TxStepKind;
  receiverId: string;
  /** Friendly contract name when known ("Rhea Lending", "Your Trellis vault"). */
  receiverLabel?: string;
  /** FunctionCall only. */
  method?: string;
  /** FunctionCall only: the JSON arguments. */
  args?: Record<string, unknown>;
  /** yoctoNEAR attached. */
  deposit: string;
  /** Human deposit, e.g. "1 yocto", "0.25 NEAR"; empty when nothing is attached. */
  depositDisplay: string;
  /** FunctionCall only: prepaid gas in Tgas. */
  gasTgas?: number;
  /** Deterministic plain-English line from the decoder. */
  label: string;
  /** False when the method isn't one the decoder knows: show a warning. */
  known: boolean;
  /** Previous step (runs before this one), if any. */
  after: number | null;
  /** Next step (runs after this one), if any. */
  before: number | null;
};

export type TxView = {
  signer?: string;
  txCount: number;
  steps: TxStep[];
  /** The transactions as sent, pretty-printed, for "copy raw JSON". */
  rawJson: string;
};

/** AI "explain this transaction" result shape (from `/api/explain-tx`). */
export type TxExplainSummary = {
  summary: string;
  commands: { index: number; plain: string }[];
};

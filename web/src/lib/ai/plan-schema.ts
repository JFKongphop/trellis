import { z } from "zod";

// Plan step grammar for wallet-mode `executePlan` and vault-mode
// `proposeVaultActions` (frontend-spec §5). Shared by the tool schemas (the
// model sees these descriptions) and the server-side builders (which validate
// with the same schemas). Tokens are a symbol (NEAR, wNEAR, USDC, USDT) or a
// token account id; the builder resolves them to account ids.

/**
 * Smaller models sometimes send arrays as JSON strings; parse them back
 * before validation.
 */
export const coerceJsonArray = (v: unknown) => {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
};

const token = z
  .string()
  .min(1)
  .describe("Token symbol (NEAR, wNEAR, USDC, USDT) or token account id. NEAR = native NEAR.");

export const originSchema = z
  .discriminatedUnion("from", [
    z.object({
      from: z.literal("amount"),
      amount: z.number().positive().describe("Human units, e.g. 10 for 10 NEAR."),
    }),
    z.object({
      from: z.literal("percent"),
      percent: z
        .number()
        .positive()
        .max(100)
        .describe("Fraction of the CURRENT wallet balance (100 = all). Only for 'all/half/25%' phrasing."),
    }),
    z.object({
      from: z.literal("step"),
      stepId: z.string().describe("Use the output of an earlier step (e.g. the swap's guaranteed minimum output)."),
    }),
  ])
  .describe("Where the step's input amount comes from.");

const base = { id: z.string().min(1).max(24).describe("Short unique step id, e.g. 'swap1'.") };

export const walletStepSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("wrap"), origin: originSchema }).describe("Wrap native NEAR → wNEAR."),
  z.object({ ...base, kind: z.literal("unwrap"), origin: originSchema }).describe("Unwrap wNEAR → native NEAR."),
  z
    .object({
      ...base,
      kind: z.literal("swap"),
      token,
      toToken: token,
      origin: originSchema,
      slippagePct: z.number().min(0.1).max(5).optional().describe("Default 0.5."),
    })
    .describe("Swap on Ref through an allowlisted single-hop pool (wNEAR/USDC 4512, wNEAR/USDT 6063, USDT/USDC 6416). NEAR input is wrapped automatically."),
  z
    .object({
      ...base,
      kind: z.literal("supply"),
      token,
      origin: originSchema,
      asCollateral: z.boolean().optional().describe("Default true (counts toward borrowing power). false = plain deposit."),
    })
    .describe("Supply to Rhea Lending. NEAR is wrapped automatically."),
  z
    .object({
      ...base,
      kind: z.literal("borrow"),
      token,
      amount: z.number().positive().describe("Human units to borrow."),
    })
    .describe("Borrow from Rhea Lending to the wallet."),
  z
    .object({
      ...base,
      kind: z.literal("repay"),
      token,
      origin: z
        .union([originSchema, z.object({ from: z.literal("all") })])
        .describe("{from:'all'} repays the full debt (a tiny overpayment stays supplied)."),
    })
    .describe("Repay Rhea Lending debt from the wallet."),
  z
    .object({
      ...base,
      kind: z.literal("withdraw"),
      token,
      source: z.enum(["collateral", "supplied"]).describe("Withdraw collateral or plain supplied deposits."),
      amount: z.number().positive().optional().describe("Human units. Omit for ALL (collateral 'all' only works with no debt)."),
    })
    .describe("Withdraw from Rhea Lending to the wallet."),
  z
    .object({
      ...base,
      kind: z.literal("send"),
      token,
      origin: originSchema,
      recipient: z.string().describe("NEAR account id, exactly as the user wrote it. Irreversible."),
    })
    .describe("Send tokens or NEAR to another account."),
  z
    .object({ ...base, kind: z.literal("depositToVault"), token, origin: originSchema })
    .describe("Move funds from the wallet into the user's Trellis vault."),
]);

export type WalletStep = z.infer<typeof walletStepSchema>;

export const vaultStepSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("wrapNear"),
    amount: z.number().positive().describe("NEAR held by the vault to wrap into wNEAR."),
  }),
  z.object({
    ...base,
    kind: z.literal("supply"),
    token,
    origin: originSchema.describe("amount / percent of the VAULT's balance, or a previous step's output."),
  }),
  z.object({ ...base, kind: z.literal("borrow"), token, amount: z.number().positive() }),
  z.object({
    ...base,
    kind: z.literal("repay"),
    token,
    origin: z.union([originSchema, z.object({ from: z.literal("all") })]),
  }),
  z.object({
    ...base,
    kind: z.literal("withdrawCollateral"),
    token,
    amount: z.number().positive(),
    deleverage: z.boolean().optional().describe("Only for deleverage steps while HF is below the policy trigger."),
  }),
  z.object({ ...base, kind: z.literal("withdrawSupplied"), token }),
  z.object({
    ...base,
    kind: z.literal("swap"),
    token,
    toToken: token,
    origin: originSchema.describe("amount / percent of the VAULT's balance, or a previous step's output."),
  }),
]);

export type VaultStep = z.infer<typeof vaultStepSchema>;

export const riskSchema = z.object({
  title: z.string().max(60),
  note: z.string().max(280),
  level: z.enum(["pass", "flag", "block"]),
});

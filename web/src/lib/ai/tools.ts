import { tool } from "ai";
import { z } from "zod";
import { GLOSSARY_KEYS } from "@/lib/ai/vault-glossary";
import {
  coerceJsonArray,
  riskSchema,
  vaultStepSchema,
  walletStepSchema,
} from "@/lib/ai/plan-schema";

/**
 * Agent tool schemas. NO `execute` functions: every tool runs CLIENT-SIDE in
 * `conversation.tsx` `onToolCall` (reads go through our /api routes; actions
 * will be signed by the user's wallet). The server never acts on its own.
 *
 * Action tools only BUILD plans: `executePlan` → transactions the user signs
 * in their wallet; `proposeVaultActions` → agent actions the owner approves;
 * `proposePolicy` → a prefilled rules form the owner saves with a signature.
 * `fundFromChain` → a NEAR Intents deposit card (the user sends from their other wallet).
 */

const accountIdParam = z
  .string()
  .optional()
  .describe(
    "NEAR account id to read, e.g. alice.near or a 64-hex implicit account. Omit to use the connected wallet.",
  );

export const agentTools = {
  getBalances: tool({
    description:
      "Read every token balance of a NEAR account: native NEAR (spendable, after storage) plus all fungible tokens, with USD values. Defaults to the connected wallet; pass `accountId` for ANOTHER account. Use for 'what do I have', 'what's in my wallet', 'how much USDC do I have', and BEFORE planning any action that depends on the user's holdings ('half my NEAR', 'all my USDC'). Tokens marked verified=false may be spam airdrops: never treat them as valuable or suggest trading them unless the user asks. Errors only if no `accountId` is given and no wallet is connected.",
    inputSchema: z.object({ accountId: accountIdParam }),
  }),
  getLendingPosition: tool({
    description:
      "Read a NEAR account's Rhea Lending (Burrow) position: collateral, debt, plain supplied deposits, health factor (from the on-chain oracle, exactly as Rhea computes it), liquidation price of each collateral token, LTV, net value, and per-token APRs. Defaults to the connected wallet; pass `accountId` for ANOTHER account. Use for 'what's my health factor', 'am I at risk of liquidation', 'show my Rhea/Burrow position', 'how much do I owe', and before any borrow/repay/withdraw advice. healthFactor null means no debt (cannot be liquidated). registered=false means the account has never used Rhea Lending.",
    inputSchema: z.object({ accountId: accountIdParam }),
  }),
  getLendingMarkets: tool({
    description:
      "List Rhea Lending markets: supply APR, borrow APR, utilization, available liquidity, total supplied (USD), collateral factor, and whether each token can be borrowed or used as collateral. Use for 'best yield for my USDC', 'what does it cost to borrow USDC', 'is there liquidity to withdraw', comparing markets, and before proposing a supply or borrow. APRs are variable and exclude reward-token incentives. Optionally filter by token symbol or account id.",
    inputSchema: z.object({
      token: z
        .string()
        .optional()
        .describe(
          "Optional filter: a token symbol (USDC, wNEAR, USDT) or token account id. Omit to list all markets.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .default(10)
        .describe("Max markets to return (sorted by total supplied USD)."),
    }),
  }),
  getTokenPrice: tool({
    description:
      "Get current USD prices for up to 10 NEAR tokens (by symbol like NEAR, USDC, wNEAR, or by token account id). Prices are from Ref Finance's indexer and are DISPLAY-ONLY: health factors and slippage checks use the on-chain oracle instead. A symbol is resolved to the best verified match; if a symbol is ambiguous or unknown, call searchToken first and pass the account id.",
    inputSchema: z.object({
      tokens: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe("Token symbols or account ids, e.g. ['NEAR', 'USDC']."),
    }),
  }),
  searchToken: tool({
    description:
      "Look up a NEAR token by symbol, name or account id and get ranked candidates with their EXACT account id, decimals, USD price and a verified flag (Ref-whitelisted or well-known). Many tokens share symbols (native USDC vs bridged USDC.e vs lookalikes); tokens are identified by account id ONLY. Use whenever the user names a token that isn't obviously NEAR/wNEAR/USDC/USDT, and never autocorrect an unfamiliar symbol to a better-known one.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe("Symbol, name or account id, e.g. 'usdc', 'ref', 'wrap.near'."),
    }),
  }),
  explainConcept: tool({
    description:
      "Look up the canonical explainer for a DeFi concept (health factor, liquidation, leverage loop, utilization, non-atomic plans, the Trellis vault, …). Always use this when the user wants to understand a risk, term, or how something works instead of freestyling. The explainer is markdown: quote it back, optionally adding 1–2 sentences tying it to the user's numbers on screen.",
    inputSchema: z.object({
      key: z.enum(GLOSSARY_KEYS).describe("Concept key from the glossary."),
    }),
  }),
};

export const actionTools = {
  fundFromChain: tool({
    description:
      "Show a card that brings funds from ANOTHER CHAIN into the user's Trellis vault or NEAR wallet through NEAR Intents (1Click). Sources: BTC (Bitcoin), ETH (Ethereum, Base, Arbitrum), SOL (Solana), USDC (Ethereum, Base, Arbitrum, Solana), USDT (Ethereum). Arrives on NEAR as USDC, wNEAR or USDT. The card shows a live quote (amount out, fees, ETA), then a one-time deposit address + QR that the user pays from their other wallet, then live status. Refunds go to the user's address on the source chain. Nothing is signed by this tool. Use for 'deposit from Base', 'bridge my ETH', 'fund my vault with BTC', 'I have USDC on Solana'.",
    inputSchema: z.object({
      target: z.enum(["vault", "wallet"]).optional().describe("Where funds go. Default: the vault if the user has one, else the wallet."),
      originSymbol: z.enum(["BTC", "ETH", "SOL", "USDC", "USDT"]).optional(),
      originChain: z.enum(["bitcoin", "ethereum", "base", "arbitrum", "solana"]).optional(),
      amount: z.string().optional().describe("Amount of the source asset, decimal string, e.g. '25'."),
      destinationSymbol: z.enum(["USDC", "wNEAR", "USDT"]).optional().describe("Token to receive on NEAR. Default USDC."),
    }),
  }),
  executePlan: tool({
    description:
      "WALLET MODE. Build a plan the user signs in their own NEAR wallet. Steps run in order as SEPARATE transactions (not atomic). Step kinds: wrap, unwrap, swap (Ref, allowlisted single-hop pools only: wNEAR/USDC 4512, wNEAR/USDT 6063, USDT/USDC 6416; NEAR input is wrapped automatically; output wNEAR, add 'unwrap' for native NEAR), supply (Rhea Lending, as collateral by default), borrow, repay (origin {from:'all'} = full debt), withdraw (source collateral|supplied; omit amount for all), send (irreversible), depositToVault. Origins: {from:'amount', amount} for a stated number, {from:'percent', percent} ONLY for all/half/x% phrasing, {from:'step', stepId} to chain an earlier step's output (uses its guaranteed minimum). Storage registrations are added automatically. Returns a summary + Guardian checks; the plan card shows the transactions and a Sign button. Nothing is signed by this tool. Requires a connected wallet.",
    inputSchema: z.object({
      steps: z.preprocess(coerceJsonArray, z.array(walletStepSchema).min(1).max(12)),
      risks: z
        .preprocess(coerceJsonArray, z.array(riskSchema).max(6))
        .optional()
        .describe("Your plan-specific risks for the Guardian (1–4 rows). Don't restate them in chat."),
    }),
  }),
  proposeVaultActions: tool({
    description:
      "VAULT MODE. Propose actions for the Trellis agent to run INSIDE the user's vault (the vault's own funds, not the wallet). The owner clicks Approve (no wallet popup); the worker then runs each step and the vault contract re-checks every one against the owner's rules (allowed tokens/pools, per-action and daily limits, max slippage, minimum health factor). Step kinds: wrapNear {amount}, supply {token, origin}, borrow {token, amount}, repay {token, origin or {from:'all'}}, withdrawCollateral {token, amount, deleverage?}, withdrawSupplied {token}, swap {token, toToken, origin} (vault allowlisted pools only). Origins refer to the VAULT's balances; chain with {from:'step'}. Use getVault first to see the vault's balances, rules and position. A leverage loop is: supply wNEAR → borrow USDC → swap USDC→wNEAR → supply that wNEAR (repeat while HF stays above the rule). Nothing runs until the owner approves.",
    inputSchema: z.object({
      steps: z.preprocess(coerceJsonArray, z.array(vaultStepSchema).min(1).max(12)),
      reasoning: z.string().max(600).describe("One or two sentences: why this plan. Stored with the agent's on-chain receipts."),
      risks: z.preprocess(coerceJsonArray, z.array(riskSchema).max(6)).optional(),
    }),
  }),
  proposePolicy: tool({
    description:
      "Prefill the vault rules form from what the user asked for ('keep it safe', 'max 1.8x', 'only USDC and NEAR'). Start from a preset: careful (~1.5x, min health factor 1.7) or balanced (~1.8x, min HF 1.5). The user reviews the form and saves it with one wallet signature. Never propose rules looser than balanced unless the user insists.",
    inputSchema: z.object({
      preset: z.enum(["careful", "balanced"]).default("balanced"),
      targetLeverage: z.number().min(1).max(2.5).optional(),
      minHealthFactor: z.number().min(1.1).max(3).optional(),
      maxSlippagePct: z.number().min(0.1).max(5).optional(),
      tokens: z.array(z.enum(["wNEAR", "USDC", "USDT"])).min(1).optional(),
      limits: z
        .array(z.object({ token: z.enum(["wNEAR", "USDC", "USDT"]), perAction: z.number().positive(), daily: z.number().positive() }))
        .optional()
        .describe("Spending limits in human units."),
      agentExpiryDays: z.number().int().min(0).max(365).optional().describe("0 = never expires."),
    }),
  }),
};

export const vaultReadTools = {
  getVault: tool({
    description:
      "Read the user's Trellis vault: whether it exists, its status (agent, paused, operation in flight), rules (allowed tokens, limits left today, min health factor), balances, Rhea Lending position + health factor, and recent agent actions (receipts, newest first). Defaults to the connected wallet's vault. Use before proposeVaultActions and for 'how is my vault doing', 'what did the agent do'.",
    inputSchema: z.object({ owner: accountIdParam.describe("Vault OWNER account. Omit for the connected wallet.") }),
  }),
};

export const allTools = { ...agentTools, ...vaultReadTools, ...actionTools };

export type ToolName = keyof typeof allTools;

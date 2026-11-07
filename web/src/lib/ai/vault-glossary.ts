// Canonical plain-English explanations for the DeFi concepts Trellis exposes
// (Rhea Lending / Burrow, Ref swaps, NEAR Intents, the policy vault). The
// agent quotes these via the explainConcept tool instead of freestyling, and
// UI surfaces (Guardian rows, dashboards) can render the same strings.
// Facts come from the rhea-burrow-lending, ref-dex-swaps, near-intents and
// trellis-vault skills. Keep live numbers (APRs, prices) OUT of this file.

export const GLOSSARY_KEYS = [
  "health-factor",
  "liquidation",
  "liquidation-price",
  "collateral-factor",
  "leverage-loop",
  "borrow-apr",
  "supply-apr",
  "utilization",
  "interest-decay",
  "oracle-price",
  "supplied-vs-collateral",
  "price-impact",
  "slippage",
  "non-atomic-plan",
  "storage-deposit",
  "wrapped-near",
  "policy-vault",
  "agent-permissions",
  "near-intents",
  "protocol-risk",
] as const;

export type GlossaryKey = (typeof GLOSSARY_KEYS)[number];

export const VAULT_GLOSSARY: Record<GlossaryKey, string> = {
  "health-factor": `**Health factor (HF)** measures how safe a borrowing position is on Rhea Lending.

HF = (collateral value × collateral factor) ÷ (debt value ÷ debt factor).

- **Above 1**: safe. **Below 1**: the position can be liquidated.
- Rhea Lending has no "warning zone" of its own: the moment HF drops under 1, anyone can liquidate part of it.
- HF falls when your collateral's price falls, when your debt's price rises, or slowly over time as borrow interest adds to your debt.

Trellis treats **1.5 or higher** as a comfortable buffer. At HF 1.5 with NEAR collateral and stablecoin debt, NEAR can fall about 33% before liquidation.`,

  liquidation: `**Liquidation** happens when your health factor goes below 1. Anyone can repay part of your debt and take some of your collateral at a discount.

- The discount grows as HF falls: discount = (1 − HF) ÷ 2. At HF 0.9 the liquidator gets about 5% off on the slice they take.
- Liquidations are partial: they continue until the position is back to a slightly better state, but every slice costs you that discount.
- If debt ever exceeds the raw value of all collateral, the position can be **force-closed** and you lose the remaining collateral.

The best defense is to keep HF well above 1 and to repay or add collateral early.`,

  "liquidation-price": `**Liquidation price** is the price of your collateral token at which your health factor hits exactly 1, assuming everything else stays the same.

Example: with wNEAR collateral and USDC debt, HF scales with the NEAR price. If HF is 1.6 and NEAR is $5, liquidation starts near $5 ÷ 1.6 ≈ $3.13, a 37.5% drop.

It moves over time: borrow interest slowly raises your debt, so the liquidation price creeps up even if nothing else changes.`,

  "collateral-factor": `**Collateral factor** (Rhea calls it the volatility ratio) is how much of a token's value counts toward your borrowing power.

- wNEAR: 75%. $100 of wNEAR counts as $75 of collateral.
- USDC / USDT: 95%.

The same number also divides your debt in that token (debt counts as value ÷ factor), so borrowing volatile tokens uses up more of your safety buffer than borrowing stablecoins.`,

  "leverage-loop": `**A leverage loop** increases exposure to a token by borrowing against it and buying more of it:

1. Supply NEAR as collateral.
2. Borrow USDC against it.
3. Swap the USDC for more NEAR.
4. Supply that NEAR too, and repeat.

Each round adds exposure but lowers the health factor. With NEAR collateral and USDC debt, 1.8× leverage leaves HF around 1.6 (NEAR can drop about 37% before liquidation); 2.5× leaves HF around 1.19 (only about a 16% drop). Gains and losses on NEAR are both multiplied, and you pay borrow interest on the USDC the whole time. Trellis caps loops at roughly 1.8–1.9×.`,

  "borrow-apr": `**Borrow APR** is the yearly interest rate on what you borrow. On Rhea Lending it is **variable**: it rises steeply when a market's utilization is high.

It is charged continuously by growing your debt, so a high borrow rate also slowly lowers your health factor. Stablecoin borrow rates can exceed 30% a year when the pool is nearly fully borrowed, which can wipe out the gains of a leverage loop.`,

  "supply-apr": `**Supply APR** is the yearly interest earned by depositing a token into Rhea Lending. It comes from borrowers' interest, so it is variable and is highest when utilization is high.

Supplying wNEAR as collateral typically earns very little (well under 1%), because few people borrow NEAR. Some markets also pay extra reward tokens; those aren't included in the base APR.`,

  utilization: `**Utilization** = how much of a lending pool is currently borrowed (borrowed ÷ supplied).

- High utilization means high borrow and supply rates.
- It also means **little liquidity is left**: suppliers may not be able to withdraw, and new borrows can fail, until someone repays or deposits.

A pool above about 90% utilization is a warning sign for both borrowers (expensive) and suppliers (withdrawals may be delayed).`,

  "interest-decay": `**Interest decay** is how a borrowing position gets slowly riskier with no price move at all: borrow interest is added to your debt continuously, so your health factor drifts down over time.

At a 30% borrow APR, debt grows roughly 2.5% a month, and HF falls by about the same share. A position left alone for months needs a top-up or a partial repay to stay at the same safety level.`,

  "oracle-price": `**Oracle price** is the on-chain price Rhea Lending uses to value collateral and debt. On NEAR it comes from \`aggregate-oracle.near\` (a Pyth-style price feed).

- Health factor and liquidations use the oracle price, not the price on a DEX or an exchange.
- Prices older than 60 seconds are rejected for actions that need them (borrow, withdraw collateral).
- Trellis shows oracle-based numbers for anything that gates money and labels any off-chain price as display-only.`,

  "supplied-vs-collateral": `**Supplied vs. collateral** on Rhea Lending:

- **Supplied**: deposited and earning supply APR, but NOT backing any loan. Doesn't help your health factor.
- **Collateral**: deposited AND counted toward borrowing power. Can be liquidated if HF goes below 1.

A token can sit in either bucket. Trellis supplies as collateral only when you intend to borrow; otherwise plain supply keeps it out of liquidation risk.`,

  "price-impact": `**Price impact** is how much your own trade moves the price you get. A 2% price impact means your effective rate is 2% worse than the spot price, usually because the trade is large compared with the pool's liquidity.

It's separate from slippage (your protection limit). Splitting a big trade or using a deeper pool lowers impact.`,

  slippage: `**Slippage tolerance** is the worst rate you'll accept before a swap fails instead of filling. On Ref, it becomes the swap's \`min_amount_out\`.

Too tight and the swap fails on normal price movement; too loose and a bot can sandwich your trade. 0.5–1% is typical for liquid pairs. Inside a Trellis vault, the contract computes the minimum output from the oracle price itself, so the agent can't loosen it.`,

  "non-atomic-plan": `**Not all-or-nothing.** On NEAR, a multi-step plan is often several separate transactions (for example: swap, then supply). Each one can succeed or fail on its own.

If step 2 fails after step 1 succeeded, you keep the result of step 1 (e.g. you now hold USDC that wasn't supplied). Trellis shows each transaction separately, tells you exactly where you ended up, and offers to retry the remaining step. Nothing is lost, but you may need one more signature.`,

  "storage-deposit": `**Storage deposit** is a small amount of NEAR (often 0.00125 NEAR per token) that registers your account with a token contract or protocol, paying for the bytes your balance uses on chain.

You need it once per token or protocol before you can receive that token or use the protocol. It is refundable when you unregister. Trellis adds these automatically and shows them in the plan.`,

  "wrapped-near": `**wNEAR (wrapped NEAR)** is NEAR packaged as a standard fungible token (\`wrap.near\`) so DeFi contracts like Ref and Rhea Lending can handle it. 1 wNEAR always equals 1 NEAR.

Wrapping and unwrapping are instant and cost only gas. Native NEAR is still what pays gas and storage, so keep a little unwrapped.`,

  "policy-vault": `**A Trellis vault** is your own smart contract account that holds funds and lets the AI agent act **only within rules you set**:

- Which tokens and pools it may touch, per-action and daily spending limits, maximum slippage, and a minimum health factor.
- Funds can only go to Rhea Lending, Ref, NEAR Intents, or back to you. The agent can never send them anywhere else.
- You can pause the agent, revoke it, change the rules, or withdraw everything at any time with your wallet.

The rules are enforced by the contract, not by Trellis's servers, so even a compromised agent is bounded by your policy.`,

  "agent-permissions": `**What the Trellis agent can and can't do.**

- In **wallet mode** it can only *propose* transactions. You review the plan and sign each one in your wallet. The AI never holds your keys.
- In **vault mode** it acts through a separate agent account whose key can only call the vault's \`agent_*\` methods. The vault checks every call against your policy (limits, allowed tokens and pools, slippage, health factor) and rejects anything outside it.
- It can never withdraw to itself or to any account other than you.`,

  "near-intents": `**NEAR Intents** lets you swap or move assets across chains (Bitcoin, Ethereum, Solana, Base, and more) by stating what you want; solvers compete to fill it.

With the 1Click API you get a deposit address on the source chain; once your deposit lands, the swap completes and funds arrive at the destination, usually within minutes. If it can't be filled, the deposit is refunded to the refund address you gave. Cross-chain transfers take longer than on-chain swaps and depend on each chain's confirmation time.`,

  "protocol-risk": `**Protocol risk** covers everything that can go wrong with the contracts and their operators: bugs, admin-key compromise, oracle failures, paused markets, or a dependency failing.

Rhea Lending (formerly Burrow) and Ref have long track records on NEAR, but Rhea suffered an exploit in April 2026 involving fake-token multi-hop swaps, and margin trading has been disabled since. Trellis limits exposure by using single-hop swaps on allowlisted pools, oracle-checked minimum outputs, and well-known tokens only.`,
};

export const GLOSSARY_LABELS: Record<GlossaryKey, string> = {
  "health-factor": "Health factor",
  liquidation: "Liquidation",
  "liquidation-price": "Liquidation price",
  "collateral-factor": "Collateral factor",
  "leverage-loop": "Leverage loop",
  "borrow-apr": "Borrow APR",
  "supply-apr": "Supply APR",
  utilization: "Utilization",
  "interest-decay": "Interest decay",
  "oracle-price": "Oracle price",
  "supplied-vs-collateral": "Supplied vs collateral",
  "price-impact": "Price impact",
  slippage: "Slippage",
  "non-atomic-plan": "Not all-or-nothing",
  "storage-deposit": "Storage deposit",
  "wrapped-near": "Wrapped NEAR",
  "policy-vault": "Trellis vault",
  "agent-permissions": "Agent permissions",
  "near-intents": "NEAR Intents",
  "protocol-risk": "Protocol risk",
};

/** Display title for a glossary key; falls back to the raw key if unknown. */
export function glossaryLabel(key: string): string {
  return GLOSSARY_LABELS[key as GlossaryKey] ?? key;
}

/** Glossary entry by key, or undefined for unknown keys. */
export function getGlossary(key: string): string | undefined {
  return VAULT_GLOSSARY[key as GlossaryKey];
}

/** Compact catalog (key + first line) for the system prompt. */
export function glossaryIndex(): string {
  return GLOSSARY_KEYS.map((k) => {
    const first = VAULT_GLOSSARY[k]
      .split("\n")[0]
      .replace(/\*\*/g, "")
      .slice(0, 90);
    return `  - ${k}: ${first}`;
  }).join("\n");
}

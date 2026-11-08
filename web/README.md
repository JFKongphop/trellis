# Trellis web app

The app for Trellis, an AI DeFi agent on NEAR. You ask in plain English; Trellis reads your NEAR wallet and your Rhea Lending (Burrow) position, builds plans you review and sign, and runs actions inside your policy vault only within rules a smart contract enforces.

## What works today

- Connect a NEAR wallet (HOT, Meteor, Intear, MyNearWallet, Ledger and more, via NEAR Connect). The header shows your account and NEAR balance.
- Chat with the agent (NEAR AI Cloud). It can:
  - read balances of your account or any `.near` account,
  - read a Rhea Lending position: collateral, debt, health factor, liquidation price,
  - list Rhea Lending markets: supply and borrow APR, utilization, liquidity,
  - look up token prices and token ids,
  - explain lending terms (health factor, liquidation, leverage loop, …).
- `/portfolio` shows your balances and Rhea position.
- **Wallet mode:** "swap 10 NEAR to USDC and supply it on Rhea" → a plan card with every step, the Risk Guardian (health factor after, borrow cost, price vs oracle, not all-or-nothing, storage deposits, …), a readable transaction viewer, and **Sign**. Each transaction shows its own status; if a later one fails you see where you ended up and can retry.
- **Vault mode:**
  - `/vault/setup`: create your vault (one signature), set rules (Careful / Balanced / Custom presets), fund it from your wallet.
  - In chat: "loop my vault to 1.8x" → a vault plan with **Approve** (no wallet popup). The agent runs each step; the vault contract re-checks every one against your rules.
  - `/vault`: health, position, rules and today's limits, agent activity, and owner controls (pause, revoke, withdraw all, edit rules).

- `/feed`: public log of every agent move across vaults, with ⚡ on automatic protection, the agent's reason, and HF before → after.
- **Cross-chain funding** (vault setup, vault page, or chat "fund my vault with USDC from Base"): NEAR Intents 1Click quote, a deposit address with a QR code, and live status. Every quote's signature is verified on the server.
- **Demo mode:** `pnpm demo` in the repo root (light replay, no wallet) or `pnpm demo:live` (local NEAR sandbox). See the root README.

The LLM never signs. Wallet plans are signed by you; vault actions are signed by the agent account and checked by your vault contract.

## Run it locally

1. Install Node 22+ and pnpm.
2. Install packages:
   ```bash
   pnpm install
   ```
3. Copy the env file and add your NEAR AI Cloud key (get one at https://cloud.near.ai):
   ```bash
   cp .env.example .env.local
   # edit .env.local: set NEARAI_API_KEY
   ```
   Without the key, the chat shows a clear error; everything else still works.
   For vault approvals also set `WORKER_URL` and `WORKER_API_TOKEN` (the worker in `../worker`), and `AUTH_SECRET`.
4. Start the app:
   ```bash
   pnpm dev
   ```
5. Open http://localhost:3000, connect a wallet, and try "what's my health factor?" or "best yield for my USDC?".

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## How it fits together

- `src/app/api/chat`: the LLM loop (AI SDK v6 + `@ai-sdk/openai-compatible` → `https://cloud-api.near.ai/v1`).
- `src/lib/ai/tools.ts`: tool schemas. Tools run in the browser (`src/components/conversation.tsx`), never on the server.
- `src/app/api/{balances,positions,markets,prices,tokens}`: read-only routes over NEAR RPC, FastNEAR and Ref's indexer.
- `src/lib/near/burrow.ts`: Rhea Lending reader. The health factor uses the same oracle (`aggregate-oracle.near`) and formula as Rhea.
- `src/lib/plan/`: plan builders. Wallet mode turns steps into NEAR transactions (`/api/plan/build`); vault mode turns steps into `agent_*` calls checked against the vault's rules (`/api/vault/preview`), signed into a 5-minute approval token.
- `src/app/api/auth/*`: NEP-413 sign-in (the wallet signs a message, the server verifies it and sets a session cookie). `/api/vault/approve` only accepts the vault's owner.
- Prices from Ref's indexer are for display only. Anything that gates money uses the on-chain oracle.

# Trellis: frontend spec (draft v0.1)

Status: draft, 2026-10-22. Companion to `vault-spec.md`. Based on the Sui app in `../sprout/web` (Next.js 16 App Router, React 19, AI SDK v6, Tailwind, shadcn/base-ui, `DESIGN.md` style).
Skills: `near-frontend` (wallet, near-api-js, data), `near-ai-agent-infra` (LLM, worker), `near-intents`, `rhea-burrow-lending`, `ref-dex-swaps`, `trellis-vault` (rules).

---

## 1. Principles

Carried over from Sprout:
1. **Chat first.** Plain English in, a reviewed plan out.
2. **The LLM never signs.** Every action is shown as a plan card with the Risk Guardian and a readable transaction before anything happens.
3. **Plain language.** No raw JSON or jargon on screen unless the user expands it.

New on NEAR:
4. **Two modes, always visible.** A mode badge on every plan card: **Wallet** (you sign each transaction) or **Vault** (the agent acts inside your rules).
5. **Be honest about atomicity.** NEAR plans can be several transactions. The UI shows each one and what happens if a later one fails.
6. **Owner controls are always one click away.** Pause, Revoke agent, Withdraw all: on the vault dashboard and in the header menu.

---

## 2. Routes

| Route | Purpose | From Sprout |
|---|---|---|
| `/` | Chat (both modes) | `app/page.tsx` + `conversation.tsx` (adapt) |
| `/vault` | Vault dashboard: position, health, agent activity, controls | **new** (borrows from `portfolio-view.tsx`) |
| `/vault/setup` | Create vault → set rules → fund | **new** |
| `/feed` | Public feed of recent vault agent actions (receipts) | `app/feed/page.tsx` (adapt data source) |
| `/portfolio` | Wallet balances + Rhea positions (wallet mode) | `app/portfolio/page.tsx` (adapt) |
| `/pay/[blob]` | Payment links | keep, low priority (stretch) |

---

## 3. User flows

### 3.1 Connect
NEAR Connect modal (HOT, Meteor, Intear, MyNearWallet, Ledger …) → header shows `alice.near` + NEAR balance. Sign-in for server features (memory, vault approvals) uses a **NEP-413 `signMessage`** once per session; the server verifies it and issues the existing HMAC session token (`proxy.ts`, `app-token.ts`).

### 3.2 Wallet mode (like Sprout)
1. User: "swap 10 NEAR to USDC and supply it on Rhea".
2. Agent calls read tools (balances, prices, Rhea markets), then `executePlan`.
3. **Plan card** shows the steps, the **Guardian**, and a **transaction list**: e.g. `Tx 1: wrap + swap on Ref (pool 4512)`, `Tx 2: supply USDC to Rhea`.
4. User clicks **Sign** → wallet opens `signAndSendTransactions` with all transactions.
5. Card tracks each tx: pending → success/failed, with a nearblocks link. If tx 2 fails after tx 1 succeeded, the card says what state the user is in ("You now hold 53.2 USDC; supply didn't happen") and offers **Retry step 2**.

### 3.3 Create a vault (`/vault/setup`)
1. **Create**: explains what a vault is (3 bullets), then **Create vault** → one wallet signature (`factory.create_vault`, ~1 NEAR deposit for storage, shown up front).
2. **Rules**: form with presets (**Careful** 1.5x / HF ≥ 1.7, **Balanced** 1.8x / HF ≥ 1.5, **Custom**). Fields: target leverage, min health factor, max slippage, per-action and daily limits per token, allowed tokens, allowed pools, enable Intents routing, agent expiry. The chat can prefill it ("keep it safe, max 1.8x" → `proposePolicy`). Plain-language summary under the form ("The agent can borrow up to … and can never send funds anywhere except Rhea, Ref and back to you"). **Save** → one signature (`set_policy` + `set_agent`, 1 yocto each, batched).
3. **Fund**: two tabs.
   - **From NEAR wallet**: pick token + amount → `ft_transfer_call` to the vault (or NEAR transfer + wrap).
   - **From another chain**: pick chain/asset (BTC, ETH, SOL, Base/Arbitrum USDC …) → 1Click quote → show deposit address + QR (`qrcode.react` already in deps), amount, estimated time, refund address → poll status until it lands in the vault.

### 3.4 Asking the agent to act inside the vault (Option A: Approve)
1. User in chat: "loop my vault to 1.8x".
2. Agent calls `proposeVaultActions` → plan card with mode badge **Vault**, the steps (`agent_supply`, `agent_borrow`, `agent_swap_ref` …), Guardian rows including **policy headroom** ("uses $120 of your $500 daily limit") and the projected health factor.
3. User clicks **Approve** (no wallet popup). The browser sends the plan id to `/api/vault/approve` with the session token.
4. Server checks: session's account == vault owner; plan id exists and is unexpired; then queues it for the worker.
5. Worker sends the `agent_*` calls one by one (each checked by the vault contract) and streams progress; the card updates live from the vault's `trellis_vault` events.
6. If the vault rejects a step (policy violation), the card shows the vault's reason, not a generic error.

### 3.5 Automatic agent actions (Option B: act, then tell)
The worker protects positions without asking (e.g. deleverage when HF < trigger). These appear:
- on `/vault` in the activity feed with a ⚡ "automatic" tag and the receipt,
- as a toast / banner next time the user opens the app ("While you were away: repaid 40 USDC to keep health at 1.55").

### 3.6 Owner controls
On `/vault` and in the header menu: **Pause agent**, **Revoke agent**, **Withdraw all**, **Edit rules**. Each is a wallet signature (owner methods need 1 yocto). Withdraw all = close the Rhea position (`owner_burrow`) then `withdraw_ft` per token; shown as a plan card like any other.

---

## 4. Screens

### 4.1 Chat (`/`)
Same layout as Sprout: `conversation.tsx`, `agent-message.tsx`, `chat-input.tsx`, `example-prompts.tsx`, `thinking-trail.tsx`, `tool-call-row.tsx`. Changes:
- Mode switch above the input (**Wallet / Vault**) when the user has a vault; it sets which tools the agent prefers.
- New example prompts: "What's my health factor?", "Loop my vault to 1.8x", "Bring 100 USDC from Base", "Best yield for my USDC?".

### 4.2 Plan card
Adapt `live-plan-card.tsx` (largest file, 2.8k LOC). Keep: steps list, Guardian panel, viewer dialog, sign button, status. Change:
- Mode badge (Wallet / Vault).
- **Transaction list** section (wallet mode): one row per NEAR transaction with receiver, actions, deposit, status.
- Button: **Sign** (wallet) or **Approve** (vault).
- Partial-failure state + retry (§3.2).

### 4.3 Risk Guardian
Keep `guardian-panel.tsx` and `plan-risks.ts` structure (LLM risks + deterministic checks). Deterministic rows for NEAR:

| Row | When |
|---|---|
| Not all-or-nothing | Plan has > 1 transaction |
| Health factor after | Any borrow / collateral change (projected HF vs policy min, liquidation price) |
| Borrow cost | Any borrow (current APR, e.g. "USDC borrow costs 32.6%/yr") |
| Price impact | Swap with impact ≥ 1% (Ref `get_return` vs oracle) |
| Policy headroom | Vault mode (per-action and daily limit usage) |
| Cross-chain delay | Intents route (ETA, refund address) |
| Storage deposit | Plan needs `storage_deposit` (small NEAR cost) |
| Irreversible send | Transfer to another account |
| Insufficient balance | as Sprout (`balance-check.ts`) |
| Oracle trust | Lending actions: prices come from Rhea's oracle (one-line disclosure) |

### 4.4 Transaction viewer
Replace the PTB decoder (`ptb-view.ts`, `ptb-explain.ts`) with a NEAR decoder: `{receiverId, actions: [FunctionCall{method, args, gas, deposit}]}`. Decode known methods into plain English (`ft_transfer_call` → "Send 10 wNEAR to Rhea lending as collateral", including the inner `msg`). Keep `ptb-dialog.tsx`, `ptb-flow-viewer.tsx`, `ptb-graph.tsx` (dagre layout) and the LLM "explain" route (`/api/explain-tx`, renamed). Unknown methods show raw JSON with a warning row.

### 4.5 Vault dashboard (`/vault`), new
- **Hero strip** (reuse `hero-stat-strip.tsx`, `count-up.tsx`, `sparkline.tsx`): net value, health factor (color bands), leverage, net APY (supply APY − borrow cost).
- **Position card**: collateral, debt, idle balances, liquidation price of NEAR.
- **Rules card**: plain-language policy summary, limits used today (progress bars), agent status (active / paused / revoked / expires in).
- **Activity feed**: vault receipts (`get_receipts` view + events), each row: what, why (reason), amounts, HF after, tx link, ⚡ automatic tag. Reuse `feed-row.tsx`, `receipt-details.tsx`.
- **Controls**: Pause, Revoke, Withdraw all, Edit rules.
- **Verified AI** badge on agent actions that have a NEAR AI signature (stretch).

### 4.6 Setup (`/vault/setup`)
Three-step wizard (Create → Rules → Fund) as in §3.3. Reuse `ui/slider.tsx`, `ui/switch.tsx`, `ui/input.tsx`, `ui/progress.tsx`.

### 4.7 Cross-chain deposit card
New `intents-deposit-card.tsx`: asset picker, amount, quote (amount out, fee, ETA), deposit address + QR + copy, memo if any, refund address field, live status (`/v0/status`). Used in setup and in chat (`fundFromChain` tool).

---

## 5. Agent tools (`lib/ai/tools.ts`)

Tools keep Sprout's pattern: zod schema, no server `execute`, run client-side in `conversation.tsx` `onToolCall`, cache rich results, return pruned output to the model.

### Reads
| Tool | Replaces | Source |
|---|---|---|
| `getBalances` | getBalance(s) | FastNEAR account API / `ft_balance_of` |
| `getLendingPosition` | getVaultBalance | Burrow `get_account_all_positions` + oracle → HF, liquidation price |
| `getLendingMarkets` | listVaults | Burrow `get_assets_paged_detailed` (APYs, utilization, caps) |
| `getVault` | — (new) | vault `get_status`, `get_policy`, `remaining_daily` |
| `getVaultActivity` | getVaultHistory | vault `get_receipts` |
| `getSwapQuote` | (inside executePlan) | Ref `get_return` on allowlisted pools + oracle price |
| `getCrossChainQuote` | — (new) | 1Click `/v0/quote` (dry) |
| `searchToken` / `getTokenPrice` | searchToken, getCoinMetadata | Ref token list + `indexer.ref.finance/list-token-price` |
| `getAccountActivity` / `getTransactionDetail` | same names | NearBlocks API + RPC `tx` |
| `explainConcept` | same | glossary (adapt `vault-glossary.ts`: health factor, liquidation, leverage loop, utilization …) |

### Actions
| Tool | Mode | What it produces |
|---|---|---|
| `executePlan` | Wallet | Plan card → `NearTx[]` signed by the user |
| `proposeVaultActions` | Vault | Plan card with **Approve** → worker sends `agent_*` calls |
| `proposePolicy` | Vault | Prefilled rules form; user saves with a signature |
| `fundFromChain` | Both | Cross-chain deposit card (1Click) to the wallet or the vault |

`executePlan` step kinds (replacing swap/split/merge/deposit/redeem/send):
`wrap`, `unwrap`, `swap` (Ref, allowlisted pool), `supply` (collateral), `borrow`, `repay`, `withdraw` (collateral or supplied), `send`, `depositToVault`, `intentsSwap`. Origins keep Sprout's `amount` / `percent` / `handle` shapes; `split`/`merge` go away (NEAR tokens are balances, not coin objects).

`proposeVaultActions` step kinds map 1:1 to vault methods: `supply`, `borrow`, `repay`, `withdrawCollateral`, `swap`, `intentsRoute`, `intentsWithdraw`. The vault re-checks everything; the UI preview is advisory.

Removed: `sendStablecoin` (Sui gasless), `resolveSuiName` (`.near` names are account ids), `getHoldersByCoinType`, `getCoins`, DCA tools (`placeDcaOrder`, `getDcaOrders`, `cancelDcaOrder`; standing orders come back as vault agent jobs later).

The system prompt (`system-prompt.ts`) is rewritten for NEAR: capabilities, the two modes, non-atomic plans, vault rules, Rhea/Ref/Intents facts, and the safety rules from the `trellis-vault` skill.

---

## 6. Plan building (`lib/ai/build-plan-transaction.ts`)

Largest piece of work. Input: validated steps. Output: `ResolvedStep[]` + `NearTx[]` + Guardian inputs.
1. Topo-sort steps (keep Sprout's logic).
2. Resolve `percent` against live balances; convert to base units (`ft_metadata.decimals`, Burrow inner decimals for lending actions).
3. Quote each swap on the allowlisted pool; `min_amount_out` from the quote with the user's slippage, cross-checked against the oracle (block if they disagree by more than the slippage).
4. Group into transactions: actions to the same receiver in one tx where possible; storage registrations added automatically (`storage_deposit` on tokens, Ref, Burrow) and shown in the Guardian.
5. Wallet mode: `signAndSendTransactions(txs)`; record results per tx; decode outcomes with all receipts (a top-level success can hide failed receipts).
6. Vault mode: produce the ordered `agent_*` call list for `/api/vault/approve`; the worker re-quotes right before sending.

---

## 7. Server routes (`app/api`)

| Route | Purpose | From Sprout |
|---|---|---|
| `POST /api/chat` | LLM loop (NEAR AI Cloud, AI SDK v6) | adapt `api/chat` |
| `POST /api/explain-tx` | LLM explanation of a transaction | `api/explain-ptb` |
| `POST /api/auth/near` | Verify NEP-413 signature → session token | new (replaces Sui verify) |
| `POST /api/vault/approve` | Owner approves a proposed vault plan → queue for worker | new |
| `GET /api/vault/[id]/stream` | Server-sent events of vault action progress | new |
| `GET /api/positions/[account]` | Burrow position + HF (server-side cache) | replaces `api/vault-balance` |
| `GET /api/markets` | Rhea lending markets | replaces `api/vaults` |
| `GET /api/prices` | Token prices | `api/token-price` |
| `POST /api/intents/quote`, `GET /api/intents/status` | 1Click proxy (keeps the partner JWT server-side) | new |
| `GET /api/activity/[account]`, `GET /api/tx/[hash]` | NearBlocks / RPC | `api/account-transactions`, `api/transaction-detail` |
| `POST /api/memory*` | Agent memory (NEP-413 grant) | adapt |

Removed: `api/sponsor-tx/*` (agent pays vault gas; optional meta-tx relay later), `api/coin-*`, `api/dca-orders`, `api/sign-receipt` (vault events replace signed receipts).

**Security for `/api/vault/approve`:** the session must belong to the vault's owner; plans expire after 5 min; each plan executes once (idempotency key). Even if this route were abused, the vault contract still enforces the policy; the route only decides *when* the agent acts, not *what* it may do.

---

## 8. Packages

Add (pinned per the `near-frontend` / `near-ai-agent-infra` skills):
`@hot-labs/near-connect@0.11.4`, `near-connect-hooks@1.1.6` (add `"use client"` wrapper; it defaults to testnet, so set mainnet explicitly), `near-api-js@7.3.1`, `@fastnear/api@2.5.0` (relay/gas keys if needed), `@defuse-protocol/one-click-sdk-typescript@0.1.26`, `@ai-sdk/openai-compatible@ai-v6` (NEAR AI Cloud; must match `ai@6`), `borsh` if needed.

Remove: `@mysten/*`, `@7kprotocol/sdk-ts`, `@bluefin-exchange/*`, `@cetusprotocol/*`, `@flowx-finance/sdk`, `@pythnetwork/pyth-sui-js`, `@mysten-incubation/memwal` (unless memory stays on Walrus), `@openrouter/ai-sdk-provider` (unless kept as fallback).

Keep: Next 16, React 19, AI SDK v6, `@ai-sdk/react`, Tailwind, base-ui/shadcn, `motion`, `@xyflow/react`, `@dagrejs/dagre`, `qrcode.react`, `react-markdown`, `zod`, `@tanstack/react-query`.

---

## 9. Build order (frontend track, Nov 1–14)

| Days | Work |
|---|---|
| Nov 1–2 | Repo setup from `../sprout/web`; remove Sui; NEAR Connect + header; NEAR AI Cloud in `/api/chat`; read tools (`getBalances`, `getLendingPosition`, `getLendingMarkets`, prices) |
| Nov 3–5 | Wallet-mode `executePlan`: step schema, plan builder, transaction list, NEAR transaction viewer, Guardian rows, partial-failure handling |
| Nov 6–7 | `/vault/setup` (create, rules form, fund from NEAR wallet); `/vault` dashboard reading the contract |
| Nov 8–9 | `proposeVaultActions` + `/api/vault/approve` + live progress; owner controls |
| Nov 10–11 | Cross-chain deposit card (1Click); automatic-action feed + "while you were away"; `/feed` |
| Nov 12–13 | Polish, mobile, README screenshots, demo video |

Depends on the contract track: vault views and events by Nov 6, agent methods by Nov 8.

---

## 10. Open questions
1. Keep agent memory on Walrus (memwal, server-keyed) or move to a simple store keyed by NEAR account?
2. Keep payment links (`/pay`) for the demo, or cut?
3. Meta-transaction relay for owner actions (gas-free setup), or let users pay the tiny NEAR gas?
4. Which NEAR AI model for chat (needs tool calling + Confidential tier), with OpenRouter as fallback?

---

## 11. Implementation notes (pass 2, 2026-10-22)

Built in `web/` (lint, typecheck, build pass). Differences from the draft above:

- **Extra routes:** `/api/auth/nonce`, `/api/auth/session` (GET/DELETE), `/api/balances/[account]`, `/api/tokens/search`, `/api/plan/build`, `/api/vault/preview`, `/api/vault/register`, `/api/vault/owner/[account]`, `/api/vault/state/[id]`.
- **Progress polling instead of server-sent events:** the plan card polls `/api/vault/plans/[id]` (proxy to the worker's `GET /plans/:id`) every 3 s; `/api/vault/[id]/stream` was not built.
- **Approval:** `/api/vault/preview` returns the plan plus a signed, stateless 5-minute approval token covering exactly those calls; `/api/vault/approve` requires a NEP-413 session whose account equals both the token owner and the vault's `get_owner`, then posts to the worker. The worker rejects duplicate `planId`s, which also blocks cross-instance replays.
- **Rules are saved in two transactions:** (1) `set_policy` + `set_agent` + `register_token`×n, (2) `setup_protocols` (it needs the tokens registered by the first transaction's callbacks).
- **Withdraw all** = repay from the vault's own balance (`owner_ft_transfer_call` OnlyRepay) → `owner_burrow` (decrease collateral + withdraw) → `withdraw_ft` / `withdraw_near`. Handles a single debt token only.
- **Wallet-mode pools:** 4512, 6063, 6416 (6063/6416 are oracle-priced "degen" pools, flagged by the Guardian, unverified).

Not built yet: multi-instance stores for nonces/approvals.
Never run with a real wallet, browser, or deployed vault; needs a NEAR AI key and the mainnet deployment.

### Automatic-action tag and "while you were away" (built Oct 22)
- The worker serves `GET /vaults/:id/reasons` from its reasoning log. `/api/vault/state/[id]` matches each receipt's `reason_hash` against it and adds `origin` (`"auto"` or `"plan"`), plus `why` and `hf_before_bps` for automatic actions. If the worker is unreachable, receipts come back untagged.
- `/vault` activity: automatic receipts show an orange ⚡ AUTO tag with the worker's reason; plan steps show "You approved".
- `components/vault/away-banner.tsx`: lists automatic moves newer than the browser's last-seen time (localStorage `trellis:lastSeen:<vault>`, default: the last 24 h) with HF before → now. "Got it" marks them seen.
- Covered by `worker_e2e.rs`: the 3 deleverage receipts map to `auto_protection` reasons.

### Sui cleanup (Oct 22)
- The transaction viewer is NEAR-native now: `lib/tx-view.ts` (`TxView`, `TxStep`: one step per action with contract, method, args, deposit, gas, transaction number), built by `decodeNearTxs` in `lib/near/decode.ts`, and rendered by `components/parts/tx-flow-viewer.tsx` + `tx-graph.tsx`. The Sui-shaped `ptb-view.ts`, `ptb-flow-viewer.tsx` and `ptb-graph.tsx` are gone, along with their objects, Move calls and coin splits.
- Deleted unused files: `count-up.tsx`, `parts/feed-row.tsx` (linked to a Sui explorer), `parts/sparkline.tsx`, `lib/intent.ts`. `/feed` will get its own NEAR row component.
- Web code has no Sui references left. Only the docs and the Intents test vector (`sprout-demo.near`, a real signed quote) still mention Sprout.

### `/feed` (built Oct 23)
- `app/feed/page.tsx`: public log of agent moves across every vault the worker protects. Stats for the last 24 h (moves, automatic, vaults active, failed), filters (All / ⚡ Automatic / Owner-approved / Failed), and rows with what happened, the worker's reason, HF before → after, the vault (explorer link) and the transaction (explorer link). Refreshes every 15 s. Linked as "Feed" in the header.
- `GET /api/feed` (10 s server cache): worker `GET /vaults` → each vault's `get_receipts` (on-chain) joined with the worker's reasons by `reason_hash` (`tagReceipts` in `lib/server/worker.ts`, shared with `/api/vault/state`). Without a worker it returns `configured: false`.
- The worker now records each action's transaction hash next to its reason (`recordTx`), so receipts on `/feed` and `/vault` link to the explorer.
- Checked against a live sandbox: `TRELLIS_DEMO_HOLD_SECS=900 cargo test -p integration-tests --test worker_e2e -- --nocapture` keeps the sandbox and worker running and prints `DEMO rpc=… worker=… token=…`. Start the web app with `WORKER_URL`, `WORKER_API_TOKEN` and `NEXT_PUBLIC_NEAR_RPC_URLS` set to those.

### Cross-chain funding (built Oct 23)
- `components/intents/intents-deposit-card.tsx`: pick the destination (vault / wallet), source asset (BTC; ETH and USDC on Ethereum, Base, Arbitrum; USDT on Ethereum; SOL and USDC on Solana; list in `lib/oneclick/assets.ts`), amount, NEAR token to receive (USDC / wNEAR / USDT), and a refund address on the source chain. A live preview (dry quote, debounced) shows amount out, minimum, fees and ETA; "Get deposit address" makes a real quote and shows the address, QR, exact amount, memo if any, a countdown to the address's deadline, and a 4-step status bar polled every 5 s (`/v0/status`). Optional tx-hash submit (`/v0/deposit/submit`). The active deposit is kept in localStorage per recipient so a reload never loses the address. If the wallet isn't registered on the token it offers a `storage_deposit`; a vault must have the token in its rules.
- Used in `/vault/setup` (Fund → "From another chain"), on `/vault` (below owner controls, to the vault or the wallet), and in chat through the `fundFromChain` tool (card rendered in the message).
- Server: `POST /api/intents/quote` (checks the recipient exists and is registered on the token; requests `depositType ORIGIN_CHAIN`, `recipientType DESTINATION_CHAIN`, `refundType ORIGIN_CHAIN`, 1% slippage, deadline 1 h / 3 h for Bitcoin; then **verifies the 1Click signature** and that the signed recipient, refund address, destination asset, amount and dry flag match the request, with no custom delivery fields). `GET /api/intents/status`, `POST /api/intents/submit`. `ONECLICK_API_KEY` is optional (lower fee).
- `lib/oneclick/signature.ts` reimplements the SDK's quote-signature check with `node:crypto` (no new dependency). `pnpm test` checks it against the real signed quote from the research: canonical string byte-exact, signature valid, tampered recipient/amount rejected. Live dry quotes for Base USDC → USDC, Ethereum ETH → wNEAR and BTC → USDC were also verified (Oct 23).
- Delivery is straight to the account as a token (not into its Intents balance), so funds are usable immediately and the vault never needs Intents for funding. The vault contract isn't involved.

### Demo modes (Oct 24)
- `pnpm demo` (default, light, ~2 GB): only the web app, in **replay** mode (`DEMO_MODE=replay`). `lib/server/demo-replay.ts` serves the vault, feed, balances and positions from a recorded run of the live demo (30 wNEAR collateral / 30 USDC debt; at $1.75 the agent withdrew 2.812 wNEAR, swapped to 14.1349 USDC and repaid, HF 1.247 → 2.14). "Crash NEAR to $1.75" plays the three moves 4 s apart. Nothing is signed: `/api/demo/send` answers with an explicit "replay" error.
- `pnpm demo:live` (heavy, ~4–6 GB free RAM): local NEAR sandbox with real Rhea/Ref/wNEAR code, the factory, the worker, and the server-side demo signer (`DEMO_MODE=1`).
- Both: a memory guard in `demo/run.mjs` sums the demo's process groups every 2 s, logs to `demo/.mem.log`, and stops everything above `DEMO_MAX_MEM_MB` (replay 3072, live 6144). Rust builds use `CARGO_BUILD_JOBS=2`; the Next server's JS heap is capped at 2 GB. Cross-chain funding is off in both demo modes (real money).
- API routes take ids as query params now (`/api/balances?account=`, `/api/positions?account=`, `/api/vault/owner?account=`, `/api/vault/state?id=`, `/api/vault/plans?id=`). The old `[param]` routes made Next dev spawn a worker per request; failed workers piled up (57 processes, 7 GB+) and crashed the dev machine.

### Money-flow graph (Oct 24)
- Every plan card (wallet and vault mode) now opens with a React Flow **money-flow graph** above the numbered steps (Sprout's plan flow, NEAR-native): nodes are where money sits or passes through (your wallet / vault, wrap.near, the Ref pool, Rhea Lending, a send recipient); arrows carry the token and amount, numbered with their plan step ("1–2" when an output flows straight into the next step, dashed orange when it's a swap estimate). Rhea's node shows the net effect (collateral / debt changes) and the health factor before → after. The transaction viewer ("View details", one node per NEAR action) is unchanged.
- The vault page's "While you were away" banner shows the same graph for the agent's ⚡ moves (Rhea → Ref → Rhea for a deleverage cycle), so it's visible in `pnpm demo`.
- Model: `lib/flow-model.ts` (pure, 5 tests in `flow-model.test.ts`); view: `components/parts/money-flow.tsx` (dagre, left → right). Plan steps now carry `pool`, `to` and `fromStep` for it.

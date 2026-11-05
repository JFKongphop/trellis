# Trellis: research summary

Researched 2026-10-22. Hackathon: build Nov 1–14 2026 (deadline Nov 14 23:59 UTC).
Tracks: **Unstoppable DeFi** (main), **AI Security & Defense** (second).

## The product in one paragraph

A per-user **policy vault** contract on NEAR holds the user's funds. The user sets rules once (allowed protocols/tokens/pools, max slippage, per-action and daily caps, minimum health factor, funds only ever return to the owner). An AI agent, whose limited key can only call the vault's `agent_*` methods, manages a leveraged lending position on **Rhea (Burrow)**, swaps on **Ref**, and brings funds in from other chains / routes to cross-chain yield through **NEAR Intents**. The vault checks every action against the rules on-chain and emits a receipt event for each. The Sprout chat UX (plan → risk guardian → readable transaction → sign) carries over for setup and manual actions.

## Go / no-go answers

| Question | Answer |
|---|---|
| Is Rhea lending live? | **Yes** on mainnet (`contract.main.burrow.near`, v0.16.2). Only *margin trading* is off after the April 2026 exploit (`get_enabled_margin_actions` = `["Withdraw"]`). Normal supply/borrow/repay works. |
| Can our vault contract own a Rhea position? | **Yes.** Everything keys on the calling account; no contract-account restriction found. Needs 0.1 NEAR storage deposit on Burrow, FT registrations, and 1 yocto attached by the vault. |
| Can the vault use NEAR Intents without keys? | **Yes.** `intents.near` authenticates contracts by calling account ("auth by predecessor"). Vault can deposit, transfer, withdraw itself. |
| Testnet? | **Mostly no.** Intents has no testnet. Burrow testnet is old (v0.11) with a dead oracle. → Test in a local sandbox, demo on **mainnet with small amounts** ($20–50). |
| Does anything like this exist on NEAR? | No contract that enforces spending rules on an AI agent on-chain was found. Clear gap. |

## Key facts per area

### Rhea (Ref DEX + Burrow lending, rebranded 2025)
- Contracts: lending `contract.main.burrow.near`; DEX `v2.ref-finance.near`; concentrated-liquidity DEX `dclv2.ref-labs.near`; aggregator `aggregatedex.near`; oracle `aggregate-oracle.near`.
- **Oracle:** use `aggregate-oracle.near` (Pyth-style, `get_price_no_older_than`). The old `priceoracle.near` flow is disabled.
- Lending calls: supply via `ft_transfer_call` to Burrow; `execute(actions)` for price-free actions; **`execute_with_pyth(actions)` required for Borrow** and for decreasing collateral while in debt. Both need 1 yocto.
- **Borrow results can't be awaited** (the promise isn't returned). The vault must reconcile afterwards by reading `get_account_all_positions`.
- **No on-chain health-factor view.** Burrow only enforces HF ≥ 1.0. The vault must compute HF itself from positions + oracle prices to enforce e.g. "min HF 1.5".
- Amounts use inner decimals (USDC has 12 extra → 1 USDC = 1e18 internally).
- Collateral factors: wNEAR 0.75, USDC/USDT 0.95, LSTs 0.70. Max theoretical leverage wNEAR/USDC ≈ 3.5x → **target 1.8–1.9x (HF 1.5–1.6)**. (Corrected: 2.5x gives HF ~1.19, liquidated after a ~16% drop.) USDC borrow APR was ~32.6% on 2026-10-22.
- Swaps: use Ref's deposit → `swap` (returns amount out) → `withdraw` flow so the vault can verify the output on-chain. **Avoid the aggregator inside the vault** (its route is an opaque server-signed blob). (Corrected:) classic pool **4512** (wNEAR/USDC) holds ~$2.4M and is the deepest; use it in the vault. Concentrated-liquidity pools don't return the output amount, so keep them out of the vault.
- **April 2026 exploit (~$18.4M):** margin module summed `min_amount_out` wrongly across hops using fake tokens/pools. Lessons for our vault: allowlist tokens **and pool IDs**, compute `min_out` from the oracle ourselves, check the actual balance received.

### NEAR Intents
- Verifier `intents.near`; `execute_intents` is atomic for ledger changes; withdrawals/cross-chain parts are not.
- **Never register the agent key with Intents** (`add_public_key`): registered keys have unrestricted control of that account's Intents balance.
- **Funding from other chains:** 1Click quote with `recipient = vault`, or POA bridge `deposit_address(account_id = vault)` (gives e.g. a BTC address). ~20–45 s for most routes.
- **Agent swaps / yield routing:** 1Click with deposit/recipient/refund type `INTENTS`, vault funds the quote's deposit address itself, then pulls output with `ft_withdraw` (no `msg`, so it refunds on failure).
- **Cross-chain yield:** 1Click "Earn" receipt tokens (Morpho on Base, Kamino on Solana, ...).
- 1Click quotes are ed25519-signed; the vault could verify on-chain (public key location unverified).
- Fees: +0.25% without a partner API key → **apply at partners.near-intents.org early**.

### Vault mechanics (NEAR protocol)
- Limited (function-call) keys: one receiver, optional method list, gas allowance, **cannot attach any deposit** → can't call `ft_transfer` directly. That's why the vault exists.
- Agent key on a **separate agent account** (not on the vault): vault checks `predecessor == agent`; `#[private]` callbacks stay safe; revoke = one owner call.
- Owner methods: `predecessor == owner` + `assert_one_yocto()` (forces a full-access-key signature; agent can't call them). Withdrawals only ever go to the owner.
- Cross-contract calls are async: debit/reserve before the call, credit only after success, callbacks never panic (`#[callback_result]`), one in-flight operation lock, settle from actual balance changes, owner can clear a stale lock.
- New: **gas keys** (NEP-611) suit an agent sending many transactions.
- Tooling (pin stable): near-sdk 5.29.1, near-workspaces 0.23.0, cargo-near 0.22.0. Sandbox can import mainnet contract wasm (not large state) → re-initialize and seed ourselves, or use small mocks + a test oracle.

### Proposed vault interface (draft)
- Owner: `set_policy`, `set_agent`, `revoke_agent`, `pause`/`unpause`, `withdraw_near`, `withdraw_ft` (to owner only), `register_token`, `clear_stale_lock`.
- Agent (non-payable, checks agent/pause/expiry/caps): `agent_supply`, `agent_borrow`, `agent_repay`, `agent_withdraw_collateral`, `agent_swap_ref(pool_id, amount)`, `agent_route_intents(quote, signature)`, `sync_position`, `deleverage_step`.
- Views: `get_policy`, `get_status`, `remaining_daily(token)`, `pending_op`, `get_receipts`.
- Events (NEP-297, standard `trellis_vault`): `action_requested`, `action_settled`, `action_failed`, `policy_changed`, `agent_revoked`, `policy_violation`. Include `reason_hash` linking to the agent's reasoning log.

### Background worker
- **Node worker on Railway/Fly**: runs deterministic checks every 10–30 s (health factor, stop-loss, limit, DCA); signs with the agent's limited key; reads FastNEAR RPC + `aggregate-oracle.near`. Cloudflare cron heartbeat as an alarm.
- **LLM: NEAR AI Cloud** (OpenAI-compatible, `https://cloud-api.near.ai/v1`) replaces OpenRouter. Use a Confidential-TEE model; fetch the signed response (`/v1/signature/{chat_id}`) → "verified AI decision" badge.
- Stretch: **OutLayer** holds the agent key inside a TEE (no human sees it). Has no scheduler; worker would trigger it. Verify testnet/cost/key-export first.
- Skip Shade Agents (no longer maintained since 2026-04-19); mention as future work.

### Frontend port
- Reuse: UI components, chat loop, AI SDK, guardian/receipt renderers, session gate.
- Adapt: system prompt, tool schemas, plan steps (add supply/borrow/repay/intent; drop split/merge), plan risks (add "not all-or-nothing", policy headroom, cross-chain delay, storage deposit), receipt encoding (BCS → Borsh), transaction viewer (NEAR actions are JSON, easier).
- Replace: wallet → **`@hot-labs/near-connect` 0.11.4 + `near-api-js` 7.3.1** (+ `near-connect-hooks`); swaps/vaults → Rhea + Intents (`@defuse-protocol/one-click-sdk-typescript`); gas sponsorship → agent pays gas for vault actions (relayer optional); SuiNS → native `.near`; feed → contract view + NearBlocks.
- Largest job: plan builder (AI plan → sequence of NEAR transactions).

## To verify before Nov 1 (small mainnet tests, manual, not project code)
1. Supply wNEAR + borrow a little USDC on Burrow from a test account via `execute_with_pyth`; then repay/withdraw.
2. 1Click: does funding via `ft_transfer_call(msg = depositAddress)` work, or must we use `mt_transfer`?
3. Where 1Click's quote-signing public key is published.
4. dclv2 (concentrated-liquidity) direct swap interface, since classic pools are thin.
5. Apply for an Intents partner API key; get a NEAR AI Cloud key.
6. Ask in NEAR Discord whether code written before Nov 1 is allowed.

## Build plan (Nov 1–14)
| Days | Contract | App / worker |
|---|---|---|
| Nov 1–3 | Vault core: owner/agent/policy, deposit/withdraw, caps, pause, events; unit tests | NEAR Connect wallet, port chat shell, NEAR AI Cloud |
| Nov 4–6 | Rhea: supply/repay/withdraw, Ref swap (deposit model), oracle + HF calc, borrow + reconcile; sandbox tests | Tools + system prompt, transaction viewer, guardian rows |
| Nov 7–9 | Intents: funding + agent routing; deleverage step | Worker: HF monitor, auto-deleverage, stop-loss |
| Nov 10–11 | Hardening, security tests (fake token, slippage, stale price, revoke) | Dashboard: positions, receipts feed, policy editor, verified-AI badge |
| Nov 12–13 | Mainnet deploy, small-amount end-to-end | README for AI judges, demo video, X post |
| Nov 14 | Buffer + submit | |

Priority if time slips: vault + Rhea lending + chat/guardian + receipts first; Intents and the worker's standing orders second; OutLayer last.

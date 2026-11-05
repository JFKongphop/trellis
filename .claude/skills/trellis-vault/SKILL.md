---
name: trellis-vault
description: >
  Project guide for "Trellis" (NEAR Hackathon, Nov 1–14 2026): the per-user
  policy vault contract, the AI agent that acts inside it, and the non-negotiable
  safety rules. Use before writing or reviewing ANY vault contract code, agent
  worker code, or agent tools/prompts that move funds — and whenever a design
  question comes up about what the agent is allowed to do.
---

# Trellis policy vault (project skill)

Trellis = Trellis's chat agent (plan → Risk Guardian → readable transaction → sign) plus a **per-user policy vault**: the user deposits funds and sets rules once; an AI agent manages a Rhea/Burrow lending position, Ref swaps, and NEAR Intents routing **only within those rules, enforced by the contract**.

Source of truth (read the relevant section before coding):
- `docs/vault-spec.md` — the contract spec (state, methods, flows, math, events, tests, open [VERIFY] items).
- `docs/research.md` — research findings, contract IDs, build plan.

Hackathon tracks: **Unstoppable DeFi** (main pitch), **AI Security & Defense** (second). Judges include AI judges: keep the README plain, with the problem, the product, and step-by-step "how to try it". Secrets go in env vars, never in the repo.

## Non-negotiable rules

These come from the threat model in the spec (§10). Do not relax them without the user explicitly agreeing.

1. **No agent method takes a free-form recipient.** Agent outflows go only to hardcoded protocol contracts (`contract.main.burrow.near`, `v2.ref-finance.near`, `intents.near`, `wrap.near`). Owner withdrawals go only to `owner`.
2. **The vault builds every outbound message itself** from typed parameters. Never let the agent pass raw JSON / protocol messages through.
3. **Never call `intents.near add_public_key`** from the vault. Registered keys have unrestricted control of the vault's Intents balance.
4. **Agent Intents routing requires a verified 1Click quote signature** with `recipient == refundTo == vault`. If verification isn't implemented, agent routing stays disabled.
5. **Swaps:** pool must be allowlisted, its token pair checked on-chain, single hop only, `min_out` computed by the vault from oracle prices (never from the agent), settle from actual balances. (Lesson from the April 2026 Rhea exploit.)
6. **Prices** come from `aggregate-oracle.near` with freshness and confidence checks. Missing/stale price → fail, never default.
7. **Health factor** is computed by the vault before every borrow / collateral decrease. Projected HF below `min_health_factor_bps` → reject (deleverage may go to `emergency_floor_bps`).
8. **Caps:** reserve against per-action and daily caps before funds leave; release only when the callback proves nothing left.
9. **One operation in flight** (mutex). Callbacks use `#[callback_result]` and never panic. Stale locks are clearable by the owner.
10. **Owner methods** check `predecessor == owner` and `assert_one_yocto()`. Owner withdraw / revoke / pause must work while paused and must not depend on Burrow, Ref or Intents.
11. **Agent identity:** separate agent account; vault checks `predecessor == policy.agent`; agent keys are function-call keys per vault limited to `agent_*` methods. Never put the agent key on the vault account.
12. **The LLM never signs.** In direct mode the user signs every transaction after seeing the plan and the Guardian. In vault mode the worker signs only `agent_*` calls, and the contract is the safety boundary.

## Architecture at a glance

| Piece | Tech | Skill |
|---|---|---|
| Vault + factory contracts | Rust, near-sdk 5.x, cargo-near | `near-rust-contracts`, `near-contract-testing` |
| Lending strategy | Rhea/Burrow `contract.main.burrow.near`, oracle `aggregate-oracle.near` | `rhea-burrow-lending` |
| Swaps | Ref v2 `v2.ref-finance.near` (deposit → swap → withdraw) | `ref-dex-swaps` |
| Cross-chain funding / yield | NEAR Intents `intents.near`, 1Click API | `near-intents` |
| Web app | Next.js (ported from `../sprout/web`), NEAR Connect, near-api-js v7 | `near-frontend` |
| LLM + worker | NEAR AI Cloud, Node worker (Railway/Fly), optional OutLayer | `near-ai-agent-infra` |

## Two user modes

- **Direct mode** (like Sui Sprout): user signs each action from their own wallet. NEAR multi-step plans are not atomic and may need several signatures; the Guardian must say so.
- **Vault mode**: user signs the policy once; the agent operates via `agent_*` methods; every action emits a `trellis_vault` NEP-297 event and is shown on the dashboard; owner can revoke/pause/withdraw anytime.

## Porting from Sui Sprout

`../sprout/` is the original Sui app (read-only reference). Reuse UI components, the chat loop, Guardian/receipt renderers. Adapt the system prompt, tool schemas, plan steps, plan risks, transaction viewer. Replace wallet, swaps, vaults, gas sponsorship, SuiNS, event feed. Details: "Frontend port" in `docs/research.md`.

## Testing expectations

Every agent method needs: a happy-path sandbox test, and attack tests from spec §11 (fake-token pool, non-allowlisted pool, slippage, stale price, HF breach, locked, callback failure, agent calling owner methods, revoked/expired/paused agent). Mainnet only with small amounts from a separate test owner account.

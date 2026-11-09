# Trellis: guide for Claude sessions

Trellis = an AI DeFi agent on NEAR that acts only inside a per-user policy vault contract. Built for the NEAR Hackathon (build window Nov 1–14 2026, deadline Nov 14 23:59 UTC). Ported from Sprout, a Sui app at `../sprout` (read-only reference; never modify it).

## Read first
- `docs/vault-spec.md`: contract spec (source of truth for the vault).
- `docs/frontend-spec.md`: screens, flows, agent tools, server routes.
- `docs/research.md`: findings, contract ids, build plan.
- `docs/pre-nov1-checklist.md`: manual mainnet checks the user runs; results feed back into the specs.

## Skills (`.claude/skills/`)
Load the matching skill before writing code: `trellis-vault` (project rules, always for anything that moves funds), `near-rust-contracts`, `near-contract-testing`, `rhea-burrow-lending`, `ref-dex-swaps`, `near-intents`, `near-frontend`, `near-ai-agent-infra`.

## Rules
- Follow the 12 non-negotiable safety rules in the `trellis-vault` skill. Don't relax them without the user agreeing.
- Pinned versions: near-sdk 5.29.1, near-workspaces 0.23.0, cargo-near 0.22.0, near-api-js 7.3.1, @hot-labs/near-connect 0.11.4, AI SDK v6.
- Build contracts with `cargo near build` (plain `cargo build` lacks `--cfg near`).
- Tests: every agent method needs a sandbox happy path and the attack tests in vault-spec §11. Check `receipt_failures()`, not just top-level success.
- Never send mainnet transactions from the user's accounts; the user runs those.
- Secrets go in env vars, never in the repo. The README must stay plain and step-by-step (AI judges read it).
- Don't change specs silently: when code and spec disagree, update the spec and say so.

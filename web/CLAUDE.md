# CLAUDE.md: Trellis web

Read `../CLAUDE.md` (project rules), `../docs/frontend-spec.md` (screens, tools, routes, build order) and `../docs/vault-spec.md` first. Load the skills in `../.claude/skills/` before touching wallet, RPC, lending, swaps, Intents or LLM code. `../../sprout/web` is the original Sui app: read-only reference for porting.

## Stack
- Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind v4, base-ui + a small shadcn-style `ui/` layer, `motion`.
- Wallet: `@hot-labs/near-connect@0.11.4` + `near-connect-hooks@1.1.6`, mounted in `components/providers.tsx` with the network set explicitly (the hooks default to testnet).
- RPC: `near-api-js@7.3.1` `FailoverRpcProvider` (`lib/near/rpc.ts`): FastNEAR, then dRPC, then rpc.mainnet.near.org. Reads only; never send transactions through the failover provider.
- LLM: AI SDK v6 + `@ai-sdk/openai-compatible@2.0.87` (the `ai-v6` line) → NEAR AI Cloud (`lib/ai/nearai.ts`). Don't upgrade to 3.x (that targets ai@7).
- Package manager: pnpm.

## Structure
```
src/
  app/            pages (/, /portfolio, /vault, /vault/setup) + api/ routes (chat, reads, auth/*, plan/build, vault/*, explain-tx)
  components/     conversation (chat loop + client tool handlers), agent-message (tool part → card), wallet-button, …
    parts/        cards: wallet-card, lending-position-card, lending-markets-card, token-list-card, guardian-panel, tx-flow-viewer + tx-graph (transaction viewer)
    ui/           design atoms
  lib/
    ai/           system prompt, tools, glossary, pricing, NEAR AI provider
    near/         config (contract ids, pools), rpc, tokens, balances, burrow (positions/markets/projection), vault (views + owner txs), tx, decode, wallet-tx, use-session
    plan/         server plan builders: build-wallet (NearTx[]), build-vault (agent_* calls), common
    server/       auth (NEP-413 + session cookie), plan-token (5-min approval token), worker client
```

## Rules
- Tools have no server `execute`: they run in `conversation.tsx` `onToolCall` and return pruned output (`pruneForModel`). The LLM never signs.
- Identify tokens by account id, never by symbol. Ref indexer prices are display-only; HF / slippage / Guardian use `aggregate-oracle.near`.
- Design system: `DESIGN.md` (canonical). `cn()` for conditional classes, no inline styles for design tokens, reuse `ui/` atoms (`BrandBadge`, `StatusDisk`, `Tag`, `PillButton`).
- Secrets only in env vars (`.env.example` lists them). `API_SIGNING_SECRET` gates `/api/*` via `src/proxy.ts`.
- Vault approvals: `/api/vault/approve` needs a NEP-413 session whose account is the vault owner (`get_owner`) and a plan token from `/api/vault/preview`. The contract is still the safety boundary.
- Gates: `pnpm lint`, `pnpm typecheck`, `pnpm build` must pass.
- No `[param]` path segments in API routes: pass ids as query params (`/api/vault/state?id=`). With a dynamic segment, Next 16 dev starts a static-paths worker process per request; when that fails they pile up (57 processes, 7 GB+ in seconds) and crashed the dev machine twice.

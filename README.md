# Trellis

**An AI DeFi agent on NEAR that can only act inside rules you set, and protects your position on its own when prices crash.**

You set the rules once: which tokens and pools, how much per action and per day, the lowest health factor allowed. A smart contract (your personal vault) holds the funds and checks every agent action against those rules on-chain. The agent then manages a leveraged lending position on Rhea (Burrow), swaps on Ref, and brings funds in from other chains through NEAR Intents. If the market drops, it deleverages before liquidation, with no signature from you, and it can never break your rules, even if the agent or our servers are compromised.

**Live on NEAR testnet**, with the agent's signing key generated and held inside a TEE (OutLayer, Intel TDX): no server and no person ever holds it. On testnet, NEAR crashed to $1.75 and the agent protected the position by itself; then we made the agent go rogue and the vault refused all four moves on-chain. [Every transaction is below.](#proof-trellis-on-near-testnet)

NEAR Hackathon 2026. Tracks: **Unstoppable DeFi** (main), **AI Security & Defense**.

**Demo video:** _add link_ · **Try it without installing:** _add link_

---

## Try it in one command (free, no wallet, no money)

Requirements: Node 22+ and pnpm (`npm i -g pnpm`).

```bash
git clone https://github.com/JFKongphop/trellis.git
cd trellis
pnpm demo
```

Then open **http://localhost:3000/vault**:

1. You are `alice.test.near`. Your vault holds a ~1.25x leveraged position: 30 wNEAR collateral, 30 USDC debt, health factor 3.56.
2. Click **Crash NEAR to $1.75**. The health factor falls to 1.25, below your 1.3 trigger.
3. Watch the agent protect the position by itself, one move every few seconds: withdraw 2.8 wNEAR collateral → swap it to 14.1 USDC on Ref → repay the debt. The health factor recovers to 2.14.
4. A **"While you were away"** banner lists the moves. Each one is tagged **⚡ AUTO** with the agent's reason. The **Feed** page shows the same moves for all vaults.

`pnpm demo` is the light mode (about 2 GB of memory). It replays a recorded run of the live demo below, with the same numbers, and nothing is signed. Press Ctrl-C to stop.

### The real thing, locally: `pnpm demo:live`

Needs Rust, `cargo install cargo-near --version 0.22.0 --locked`, and 4–6 GB of free memory.

```bash
pnpm demo:live
```

This starts a local NEAR sandbox with the **real Rhea (Burrow), Ref and wNEAR contract code**, downloaded from mainnet and deployed at their mainnet account ids. On top of that it deploys the Trellis factory, creates alice's vault through it, sets the rules, starts the Trellis worker, and opens the leveraged position through an owner-approved plan. The price buttons then move the sandbox oracle, and the worker really deleverages through the vault contract. Owner controls (pause, revoke, edit rules, withdraw) are signed by a demo key on the server instead of a browser wallet.

Both modes stop themselves if they use more memory than allowed (3 GB / 6 GB) and log per-process memory to `demo/.mem.log`.

### On NEAR testnet: `pnpm demo:testnet`

The same app against the testnet deployment below: every click is a public transaction. Needs the deployment's keys in `.env.testnet` (git-ignored), so it runs for whoever deployed it. To deploy your own copy (free faucet NEAR, no Rust needed):

```bash
pnpm -C worker install
pnpm -C worker testnet:setup       # deploys mock USDC, our oracle, Ref + Rhea (mainnet code), the factory; creates a vault with rules
pnpm -C worker testnet:outlayer    # creates the agent's OutLayer wallet (key generated inside the TEE)
pnpm -C worker testnet:tee-agent   # makes that wallet the vault's only agent
pnpm demo:testnet                  # worker + price keeper + web app → http://localhost:3000/vault
pnpm -C worker testnet:rogue       # the rogue-agent attempts
pnpm -C worker testnet:verify-tee  # the TEE checks (read-only)
```

### A link anyone can open: the testnet replay

The web app can replay the recorded testnet run: the same vault, the same three automatic moves, and every **tx ↗** opens the real transaction on testnet.nearblocks.io. Nothing runs or signs in the background, so it can be hosted for free. On Vercel, import the repo with **Root Directory** `web` and these environment variables:

```bash
DEMO_MODE=replay
NEXT_PUBLIC_DEMO_MODE=replay
NEXT_PUBLIC_NEAR_NETWORK=testnet
NEXT_PUBLIC_TRELLIS_FACTORY=app.trellis-mw6t5fzt.testnet
NEXT_PUBLIC_TRELLIS_AGENT=a48ed23b485f0d5899757f37ac41c8c1ad25e9477e5aab7ed185bd341998d7cc
NEXT_PUBLIC_BURROW=burrow.trellis-mw6t5fzt.testnet
NEXT_PUBLIC_ORACLE=oracle.trellis-mw6t5fzt.testnet
NEXT_PUBLIC_REF_EXCHANGE=ref.trellis-mw6t5fzt.testnet
NEXT_PUBLIC_WRAP=wrap.testnet
NEXT_PUBLIC_USDC=usdc.trellis-mw6t5fzt.testnet
NEXT_PUBLIC_REF_POOL=0
API_SIGNING_SECRET=<openssl rand -hex 32>
```

---

## Proof: Trellis on NEAR testnet

Everything below is a public transaction on NEAR testnet. Rhea (Burrow) on testnet is an old version with a stale oracle, so we deployed **the real mainnet code of Rhea and Ref** ourselves (see [What is real](#what-is-real-and-what-is-simulated)).

| | Account |
|---|---|
| Factory | [`app.trellis-mw6t5fzt.testnet`](https://testnet.nearblocks.io/address/app.trellis-mw6t5fzt.testnet) |
| Alice's vault | [`v866c8a018d8854a3.app.trellis-mw6t5fzt.testnet`](https://testnet.nearblocks.io/address/v866c8a018d8854a3.app.trellis-mw6t5fzt.testnet) |
| Agent (key held in OutLayer's TEE) | [`a48ed23b…98d7cc`](https://testnet.nearblocks.io/address/a48ed23b485f0d5899757f37ac41c8c1ad25e9477e5aab7ed185bd341998d7cc) |
| Rhea Lending (mainnet code) · Ref v2 (mainnet code) | [`burrow.trellis-mw6t5fzt.testnet`](https://testnet.nearblocks.io/address/burrow.trellis-mw6t5fzt.testnet) · [`ref.trellis-mw6t5fzt.testnet`](https://testnet.nearblocks.io/address/ref.trellis-mw6t5fzt.testnet) (pool 0) |
| Price oracle (ours) · USDC (mock) · wNEAR | [`oracle.trellis-mw6t5fzt.testnet`](https://testnet.nearblocks.io/address/oracle.trellis-mw6t5fzt.testnet) · [`usdc.trellis-mw6t5fzt.testnet`](https://testnet.nearblocks.io/address/usdc.trellis-mw6t5fzt.testnet) · [`wrap.testnet`](https://testnet.nearblocks.io/address/wrap.testnet) |

| Step | Transaction |
|---|---|
| **Setup** | |
| Trellis factory deployed, bound to our Rhea, Ref and oracle (fixed at init) | [2Pyev61g…](https://testnet.nearblocks.io/txns/2Pyev61gQEDNGNSQ2GnPfEBVJGfQduoF4osgKvV5rKex) |
| Vault code stored in the factory (398 KB) | [7WVuoXoB…](https://testnet.nearblocks.io/txns/7WVuoXoB7Cmv5hVbHyfq7exV7rpnrwYYY76EnkczQccr) |
| Alice creates her vault through the factory (no access keys on it) | [5idQ1x7a…](https://testnet.nearblocks.io/txns/5idQ1x7a9qMDow1jF9cXgvzow6RcpUQs2qMMeyJ1rqn4) |
| Alice signs her rules once: allowed tokens and pool, caps, min health factor 1.5, deleverage below 1.3 | [EH32j1zV…](https://testnet.nearblocks.io/txns/EH32j1zVnhPH8r1zuhxSnXS9m13Y6sDNCySdtNQrVrQ7) |
| Alice deposits 2.5 wNEAR | [HDnR9SHe…](https://testnet.nearblocks.io/txns/HDnR9SHeEpDqMHoCWMC2oK1Govq7KLz3V69oxQGHLxDo) |
| **A leveraged position (owner-approved plan, run by the agent)** | |
| Supply 2 wNEAR as collateral on Rhea | [BaAySERd…](https://testnet.nearblocks.io/txns/BaAySERdMVtbz8AJBTGhDGV3hPSyL3rzLbBAoWM1Naib) |
| Borrow 3 USDC | [GKEzYxa1…](https://testnet.nearblocks.io/txns/GKEzYxa1g3AcZjeVXc6UfL4pZS14P5YzgPmTNgRPSM5M) |
| Swap 3 USDC → wNEAR on Ref | [HHZnmFzo…](https://testnet.nearblocks.io/txns/HHZnmFzoG7Co6tC8AVcgdubaSkZk58jmXthw5CWBuHJx) |
| Supply 1 wNEAR more → health factor 3.56 | [DGA1arWS…](https://testnet.nearblocks.io/txns/DGA1arWSFGxyhJEGsSg6WoaSXeAia9B78m1ow1TN6pBj) |
| **The agent's key moves into a TEE** | |
| Alice makes the OutLayer TEE wallet the vault's only agent | [DY5xjDZy…](https://testnet.nearblocks.io/txns/DY5xjDZy552mXCvuBH1Q3ydhQGMe2iM1uZ8k1x1iSjMm) |
| **NEAR crashes to $1.75: the agent protects the position on its own (health factor 1.25 → 2.16)** | |
| Withdraw 0.28 wNEAR collateral (signed in the TEE) | [Gah22jsX…](https://testnet.nearblocks.io/txns/Gah22jsXE3K7oxgmeph3rZrxAJQMVD9VwF15L85K9ewk) |
| Swap it to USDC on Ref | [8BQuAqdH…](https://testnet.nearblocks.io/txns/8BQuAqdHE4MrRhSE2BYD12MnwACDwYhpwfMZqCxMLxkE) |
| Repay 1.43 USDC of debt | [GmuKA6SF…](https://testnet.nearblocks.io/txns/GmuKA6SFbQDfQvBFAW35tvwbcbs48FCp4ecpXoBYLH38) |
| **The agent goes rogue (signed in the TEE, as the real agent): the vault refuses every move** | |
| Rewrite its own rules → `ERR_NOT_OWNER` | [4oEXGqsB…](https://testnet.nearblocks.io/txns/4oEXGqsB1vYo4U2Dyk6AT5Py79mECCPsL38Nu1TjJ6za) |
| Swap through a pool Alice never allowed → `ERR_POOL_NOT_ALLOWED` | [BR29DVG9…](https://testnet.nearblocks.io/txns/BR29DVG9yDabQuNUZReNFiCx5q5UajSk67cm5nk9DpKb) |
| Move 3 wNEAR out at once (cap is 2) → `ERR_PER_ACTION_CAP` | [7eNq5rmn…](https://testnet.nearblocks.io/txns/7eNq5rmn7UHfKXCuBHmpe1eW6YmHuZDSVG9NuXmQawM4) |
| Borrow 8 USDC, below the 1.5 health-factor floor → `policy_violation: min_health_factor` | [D1Qc4Veg…](https://testnet.nearblocks.io/txns/D1Qc4VegqBq8fhFFs5ZicdHTM2rzo1EN7QgXenEnzjEq) |

Check the vault yourself:

```bash
near contract call-function as-read-only v866c8a018d8854a3.app.trellis-mw6t5fzt.testnet get_status json-args '{}' network-config testnet now
near contract call-function as-read-only burrow.trellis-mw6t5fzt.testnet get_account_all_positions json-args '{"account_id":"v866c8a018d8854a3.app.trellis-mw6t5fzt.testnet"}' network-config testnet now
```

### Verify the TEE

The agent's NEAR key is created and kept inside [OutLayer](https://outlayer.ai)'s keystore, an Intel TDX enclave. No server of ours and no person ever holds it; the worker only asks the enclave to sign. `pnpm -C worker testnet:verify-tee` checks, on testnet:

- the vault trusts exactly one agent, `a48ed23b…98d7cc`, and the vault itself has **0 access keys** (no one can sign as the vault);
- the agent account has **1 key**, its own implicit key (no one added another);
- OutLayer's keystore gets its master secret from **NEAR MPC** (`v1.signer-prod.testnet`) and only for approved code: [`dao.outlayer.testnet`](https://testnet.nearblocks.io/address/dao.outlayer.testnet) lists **19 approved Intel TDX measurements** (MRTD + RTMR0-3);
- [`worker.outlayer.testnet`](https://testnet.nearblocks.io/address/worker.outlayer.testnet) holds **52 worker keys**, each added only after its TDX quote passed an on-chain check.

What this doesn't prove by itself: that this exact key was derived inside the enclave. That rests on OutLayer's design (key = HMAC of the MPC-released master secret and the wallet id, inside the attested keystore). On testnet OutLayer's keystore DAO has 1 member.

## How it works

```
 you (wallet)                       Trellis web app (Next.js)                  NEAR AI Cloud (LLM)
   │  set rules, fund, pause          │  chat → plan card → you sign or Approve    │  only proposes;
   │  (owner methods, 1 yocto)        │  vault page, ⚡ banner, /feed, Intents card │  never signs
   ▼                                  ▼
 ┌────────────────────────────────────────────────────┐        ┌──────────────────────────────┐
 │  your vault  v<hash>.trellis.near  (Rust contract) │◄──────│  Trellis worker (Node)        │
 │  holds funds · no access keys · owner = you        │ agent_*│  per-vault function-call key  │
 │  checks EVERY agent action against your Policy     │ calls  │  watches health factor,       │
 └────────────────────────────────────────────────────┘        │  deleverages, runs approved   │
     │ supply / borrow / repay      │ swap         │ route     │  plans, logs its reasoning    │
     ▼                              ▼              ▼           └──────────────────────────────┘
  Rhea Lending (Burrow)        Ref v2 DEX     NEAR Intents (1Click)
  prices: aggregate-oracle.near
```

- **Wallet mode:** you ask in chat ("swap 10 NEAR to USDC and supply it"), Trellis builds a plan with a risk check (health factor after, cost, price vs oracle), and you sign each transaction in your own wallet.
- **Vault mode:** you sign your rules once. After that, plans you **Approve** and automatic protection run through the vault's `agent_*` methods, and the contract re-checks every one.
- **Cross-chain funding:** fund the vault with BTC, ETH, SOL, USDC or USDT from Bitcoin, Ethereum, Base, Arbitrum or Solana through a NEAR Intents (1Click) deposit address. Every quote's 1Click signature is verified before it's shown.

## Why the agent can't go rogue (enforced by the contract, not by the AI)

| Rule | How |
|---|---|
| Funds only move between your vault, the allowed protocols, and you | No agent method takes a recipient. Withdrawals go to the owner only. Protocol ids are fixed at creation. The vault has no access keys. |
| Spending limits | Per-action and per-day caps for every token, reserved before funds leave and released only if nothing was spent. |
| Never below your health factor | Before every borrow or withdrawal the vault reads Rhea positions, live risk settings and oracle prices itself, and rejects it if the projected HF is below your minimum. |
| Deleveraging can't be abused | Allowed only below your trigger, and only down to the emergency floor. It then opens a cycle in which the agent may only swap that collateral and repay. |
| Fair prices | The vault computes the minimum swap output from the oracle (never from the agent), and uses only allowlisted single-hop pools with a pair check. Intents quotes must be 1Click-signed, deliver to the vault, and price within 0.5% of the oracle. |
| Stale or shaky oracle data blocks actions | Price age, future timestamps and confidence width are all checked. |
| One action at a time | A lock covers every async step; every callback ends by settling or releasing it. |
| You stay in control | Pause, revoke and owner withdrawals work at any time and don't depend on any protocol. The agent's permission can expire. Only you can upgrade your vault, by code hash. |

**Tested on testnet against the real agent:** the four rogue moves in the [proof table](#proof-trellis-on-near-testnet) were signed in the TEE as the vault's agent, and the vault refused each one.

| Also | How |
|---|---|
| The agent's key can't be stolen from our server | It's not on our server. It's created and kept inside OutLayer's TEE; the worker only asks it to sign. |

**Security review.** An independent review of the vault and factory found 0 critical, 0 high, 4 medium, 6 low and 4 info issues (14 in total). All are fixed, and each has a test. See `docs/vault-spec.md` §15.

## Tested

| What | Command | Result |
|---|---|---|
| Vault and factory unit tests | `cd contracts && cargo test -p trellis-vault -p trellis-factory` | 55 + 4 pass |
| Sandbox tests against real Rhea / Ref / wNEAR code (supply → borrow → swap → repay, slippage, stale price, wrong pool, access control, deleverage guard, factory refunds) | `cd contracts && cargo test -p integration-tests --test vault_flows --test factory` | 7 + 3 pass |
| Worker end to end: crash NEAR to $1.80, the worker deleverages on its own (HF 1.28 → 2.68), then runs an owner-approved plan | `cd contracts && cargo test -p integration-tests --test worker_e2e` | pass |
| Worker decision logic | `cd worker && pnpm test` | 20 pass |
| 1Click quote-signature check against a real signed quote | `cd web && pnpm test` | 4 pass |
| Web typecheck, lint, build | `cd web && pnpm typecheck && pnpm lint && pnpm build` | pass |
| Factory binds each vault to its protocol contracts (used by the testnet deployment) | `cd contracts && cargo test -p trellis-factory && cargo test -p integration-tests --test factory` | 5 + 4 pass |
| On NEAR testnet: position, crash, TEE agent deleverages on its own, four rogue moves refused | `pnpm -C worker testnet:run`, `testnet:rogue` | [proof table](#proof-trellis-on-near-testnet) |

Sandbox tests need the contracts built first (`cargo near build non-reproducible-wasm` in `vault/`, `factory/`, `mock-oracle/`) and internet on the first run to fetch mainnet code. Measured gas: borrow 91 Tgas, swap 81, supply 29, repay 24.

## Repository

| Folder | What's inside |
|---|---|
| `contracts/` | Rust (near-sdk 5.29): `vault/` the policy vault, `factory/` one vault per user (shared code by hash, ~1.5 NEAR per vault), `integration-tests/` sandbox tests and the live demo launcher. See `contracts/README.md` for build and mainnet deploy. |
| `worker/` | Node agent: health watching, deleverage, approved plans, reasoning log; signs through OutLayer's TEE (or per-vault function-call keys). `src/testnet/`: testnet deploy, runner, rogue-agent test, TEE check. See `worker/README.md`. |
| `web/` | Next.js app: chat (NEAR AI Cloud), wallet and vault modes, vault page, `/feed`, cross-chain funding. See `web/README.md`. |
| `demo/` | `pnpm demo` / `pnpm demo:live` / `pnpm demo:testnet` runner. |
| `testnet/` | `deployment.json`: the testnet accounts and every proof transaction. |
| `docs/` | `vault-spec.md` (contract spec + security fixes), `frontend-spec.md`, `research.md`, `pre-nov1-checklist.md`. |

## Run the real app (mainnet)

1. Deploy the factory and publish the vault code: `contracts/README.md`.
2. Start the worker with an agent account: `worker/README.md`.
3. Start the web app: `cd web && cp .env.example .env.local`, fill in `NEARAI_API_KEY` (chat), the factory and agent ids, and the worker URL and token, then `pnpm install && pnpm dev`.

## What is real and what is simulated

| Part | Status |
|---|---|
| Trellis vault + factory, every rule and refusal | **Real**, NEAR testnet |
| Rhea Lending (Burrow) and Ref v2 | **Real mainnet code**, deployed by us on testnet with Rhea's live mainnet risk settings (Rhea's own testnet deployment is an old version with a dead oracle) |
| wNEAR | **Real**, `wrap.testnet` |
| USDC | Mock token (Circle has no USDC on NEAR testnet) |
| Price oracle | **Ours**: same interface as `aggregate-oracle.near`. We set the NEAR price (that's how the crash happens) and refresh it every 20 s |
| Agent key | **Real** OutLayer custody wallet on testnet: generated and held in their TEE |
| Cross-chain funding (NEAR Intents) | Mainnet only: Intents has no testnet. Quotes and their signature check are tested against live 1Click |
| Amounts | 1/10 of the sandbox demo (same prices, same health factors) |

## Current limits

- **Not on mainnet yet.** It runs on testnet (above). The mainnet deploy costs about 50 NEAR (mostly the one-time code publish).
- **Chat needs a NEAR AI Cloud key** (`NEARAI_API_KEY`). The vault, feed, demo and funding card work without it.
- **Cross-chain funding is real money only.** NEAR Intents has no testnet, so it's off in the demo modes and on testnet. Quotes and signature checks are tested against live 1Click.
- 1Click, the bridges and the Rhea/Ref contracts are third parties. The vault limits how much any of them can touch through caps.
- **The TEE is OutLayer's.** Trust in the agent's key rests on Intel TDX and OutLayer's attested keystore (see [Verify the TEE](#verify-the-tee)). If the TEE failed, the vault's rules still hold: a stolen key could only make the moves the rules allow, as the rogue-agent test shows.

# OutLayer (stretch): TEE-held agent key + verifiable compute

Researched 2026-10-22 from app.outlayer.ai `llms.txt` / `llms-full.txt`, `https://api.outlayer.ai/openapi.json`,
and live `GET /public/pricing`, `testnet-api.outlayer.ai/health`. No account or key was created.
Priority per the research doc: **last** (after vault + Rhea + chat + receipts + worker).

## What it is

Two products on one Intel TDX enclave fleet, coordinated by a (closed-source) coordinator, with the verifiable
pieces (keystore worker, worker, contracts) open source at github.com/out-layer/outlayer:

1. **Agent Custody wallets** — `POST /register` creates a wallet; the keystore derives keys inside the enclave:
   `HMAC-SHA256(master_secret, "wallet:{wallet_id}:near")` → **Ed25519 → NEAR implicit account** (64-hex id), plus
   EVM (secp256k1) and Solana (ed25519). The master secret comes **once at enclave start from the NEAR MPC network
   via CKD** (confidential key derivation), encrypted to an enclave key; nobody sees private keys. An owner-set,
   on-chain-stored, TEE-decrypted **policy** is checked before every signature.
2. **Verifiable WASI compute** — publish a WASI (P1/P2) wasm; run it from a NEAR contract (`outlayer.near`
   `request_execution` → callback) or over HTTPS; the result comes back signed by the enclave with an attestation.
   Projects get encrypted **secrets**, persistent storage, VRF, and **signing keys** (ed25519 keys derived per
   project/build/caller that the module can use but never see, incl. NEP-413 from the key's implicit account).

| | Mainnet | Testnet |
|---|---|---|
| API | `https://api.outlayer.ai` | `https://testnet-api.outlayer.ai` (health OK 2026-10-22) |
| Contract | `outlayer.near` | `outlayer.testnet` |
| Dashboard/docs | `https://app.outlayer.ai` (serves no API) | same |
| Not on testnet | every `/wallet/v1/intents/*`, `/wallet/v1/confidential/*`, cross-chain withdrawals | |

Interactive API ref: `https://api.outlayer.ai/docs`; OpenAPI: `/openapi.json`; TS SDK: `@outlayer/sdk`; Rust crate `outlayer`; CLI `outlayer`.

## Auth

- `Authorization: Bearer wk_…` — wallet API key from `/register` (shown once). Also gives a trial quota
  (docs: 100 free WASI executions per wallet) for `/call`.
- `X-Payment-Key: owner:nonce:secret` — prepaid USD balance for paid `/call` executions (`outlayer keys create`).
- No `X-API-Key`. `/register` is unauthenticated, rate-limited 30/min/IP. A wallet can be bound to a NEAR account via
  NEP-413 proof (full-access key required).

## How Trellis could use it: agent key inside a TEE

Today: `agent.trellis.near` + per-vault function-call keys on the worker (agent-worker.md). With OutLayer the
worker never holds a signing key:

```
worker (deterministic rules) ──POST /wallet/v1/call──▶ OutLayer keystore TEE
                                                         policy check (receiver allowlist, rate limit)
                                                         sign as <64-hex implicit account> → broadcast
vault: policy.agent = "<that implicit account>"  (predecessor check unchanged)
```
- The vault's `set_agent(agent)` points at the custody wallet's implicit account instead of `agent.trellis.near`.
  No access keys to provision; revoke is still the owner's `revoke_agent()`.
- Two independent policy layers: OutLayer policy (which contracts/methods, rate, freeze) + the vault policy.
- The implicit account pays gas for `/wallet/v1/call` → fund it with ~1 NEAR (it must exist on-chain to sign;
  any NEAR transfer to a 64-hex id creates it). [VERIFY] who pays gas for `/wallet/v1/call`.
- Never use the custody wallet's Intents features against the vault's balance; the vault holds funds, the wallet
  holds only gas money.

```ts
// worker side — request/response per api.outlayer.ai/openapi.json (CallRequest)
const OUTLAYER = process.env.OUTLAYER_API ?? "https://api.outlayer.ai";

export async function outlayerAgentCall(vaultId: string, method: string, args: object, idempotencyKey: string) {
  const r = await fetch(`${OUTLAYER}/wallet/v1/call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OUTLAYER_WALLET_KEY}`,   // wk_… (secret)
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey,  // per openapi: a reused key returns HTTP 200 with error "duplicate_idempotency_key" + request_id; nothing runs twice
    },
    body: JSON.stringify({
      receiver_id: vaultId,
      method_name: method,
      args,                                // or args_base64
      gas: "300000000000000",              // spec text says "TGas as a string" but defaults to 30000000000000 → yoctogas [VERIFY]
      deposit: "0",
    }),
  });
  if (r.status === 409) throw new Error("wallet busy: another money-moving op in flight"); // retry with backoff
  if (r.status === 403) throw new Error(`policy denied: ${await r.text()}`);
  const body = await r.json();             // CallResponse { request_id, status, tx_hash?, result? }; status may be "pending_approval" under multisig
  if (body.error === "duplicate_idempotency_key") return body;            // already sent: poll body.poll_url (/wallet/v1/requests/{id})
  return body;
}
```

Policy JSON (stored encrypted on-chain; set via `/wallet/v1/encrypt-policy` → `/wallet/v1/sign-policy` →
`/wallet/v1/policy`, owner-signed). Relevant fields for Trellis:

```json
{
  "version": 1, "frozen": false,
  "rules": {
    "transaction_types": ["call"],
    "addresses": { "mode": "whitelist", "list": ["alice-near.trellis.near"] },
    "rate_limit": { "max_per_hour": 120 }
  },
  "capabilities": { "swap": { "allowed": false }, "cross_chain_withdraw": { "allowed": false }, "raw_sign": { "allowed": false } }
}
```
Whether `addresses.whitelist` applies to `call` receivers (vs. transfer recipients) and whether method names can be
restricted: [VERIFY] in the Agent Custody docs. Per-tx limits are enforced in the TEE; hourly/daily limits use
coordinator-held usage (best-effort, coordinator DB compromise could reset them).

## Attestation

- Keystore/worker enclaves produce Intel TDX quotes; a NEAR contract verifies Intel's chain, rejects outdated TCB,
  and compares the build's measurements to an approved list (DAO-governed keystore). `GET /tdx/collateral` public.
- Every WASI run returns an attestation over code hash, input, output. On-chain result verification is described
  in "NEAR Contract Integration"; ed25519 verify on NEAR costs ~26 Tgas (`env::ed25519_verify`).
- For Trellis's AI Security story: "agent key generated and held in an attested TEE, released by NEAR MPC CKD,
  policy-gated" is a strong claim, but the coordinator API is closed source and holds velocity-limit state.

## Secrets / CKD for WASI projects

- `outlayer secrets set/update` with generation types `hex16|hex32|hex64|ed25519|ed25519_seed|password[:N]` —
  values are generated inside the TEE and exposed to the module as env vars (`PROTECTED_*`), never shown to you.
- So CKD **can** yield a NEAR ed25519 key two ways: (a) the custody wallet's implicit-account key (simplest),
  (b) a project secret of type `ed25519` or a declared signing key, used by your WASI module to sign NEAR txs/NEP-413.
  Adding (b)'s public key as a function-call key on `agent.trellis.near` would keep the named agent account; that
  needs the public key exported (signing-keys docs expose public keys) [VERIFY].
- WASI resource limits (live `/public/pricing`): `max_instructions` 5e11, `max_execution_seconds` 180,
  `max_compilation_seconds` 300. Blockchain-mode input ≤ ~900 bytes.

## Pricing (live `GET https://api.outlayer.ai/public/pricing`, 2026-10-22)

`{ base_fee: 1e21 yocto (0.001 NEAR), per_instruction_fee: 1e14, per_ms_fee: 1e17, per_compile_ms_fee: 1e17,
base_fee_usd: "1000", per_instruction_fee_usd: "1", per_sec_fee_usd: "1", per_compile_ms_fee_usd: "10" }`.
USD fields look like micro-USD (base $0.001); instruction-fee unit (per million instructions?) unclear [VERIFY].
Wallet API call pricing isn't published in the docs fetched [VERIFY]; trial quota first.

## No scheduler

OutLayer runs on request only (contract call or HTTPS). Trellis still needs the Node worker (or a Cloudflare cron) to
decide *when* to act; OutLayer only replaces *where the key lives* (and optionally where the decision logic runs,
if you port `decide()` to a WASI module for an attested decision).

## Decision guide

| Option | Effort | Security story | Use when |
|---|---|---|---|
| FC keys on worker (agent-worker.md) | low | bounded by FC key scope + vault policy | MVP, default |
| OutLayer custody wallet as `policy.agent` | medium (register, fund, policy, swap signer in worker) | key never on any server; TEE + MPC; extra policy layer | time left after Nov 11, AI Security track pitch |
| WASI module with signing key + on-chain attested result | high | decision logic itself attested | not for this hackathon |

Before committing: test on `testnet-api.outlayer.ai` with a throwaway vault (wallet `/call` works on testnet),
confirm gas payer + `gas` units, policy receiver allowlisting, latency under the 15 s tick, and that `409 busy`
doesn't stall multiple vaults sharing one wallet (one wallet per vault avoids it).

# near-cli-rs commands and raw RPC (FastNEAR)

Verified 2026-10-22: near-cli-rs 0.30.1 (crates.io), docs.near.org tools/cli + api/rpc pages, near-cli-rs
`docs/GUIDE.en.md`, cargo-near template workflows. FastNEAR endpoints were live-checked (mainnet protocol 86, nearcore 2.13.4;
testnet protocol 88, 2.14.0-rc.5).

Install: `npm install -g near-cli-rs@latest` or `cargo install near-cli-rs` (binary: `near`).
Commands below use the explicit (non-interactive) form; each ends with `network-config <testnet|mainnet>` and
for transactions `sign-with-keychain send` (alternatives: `sign-with-legacy-keychain`,
`sign-with-plaintext-private-key <ed25519:...>`, `sign-with-access-key-file <path>`, `sign-with-ledger`).
Running `near` with no args starts interactive mode, which prints the full command it built (handy for discovering flags).
Short legacy-style aliases also exist (`near call`, `near view`, `near deploy`, `near create-account --useFaucet`).

## 1. Accounts
```bash
# testnet account funded by the faucet
near account create-account sponsor-by-faucet-service trellis-dev.testnet \
  autogenerate-new-keypair save-to-keychain network-config testnet create

# subaccount funded by its parent (works on mainnet too)
near account create-account fund-myself agent.trellis-dev.testnet '1 NEAR' \
  autogenerate-new-keypair save-to-keychain sign-as \
  network-config testnet sign-with-keychain send
# (bare `sign-as` = signed by the parent account, as in the near-cli-rs guide; interactive mode lets you pick another signer)

near account view-account-summary trellis-dev.testnet network-config testnet now
near account list-keys trellis-dev.testnet network-config testnet now
near account import-account using-web-wallet network-config mainnet     # bring a wallet account to the CLI
near account delete-account <acct> beneficiary <beneficiary> network-config testnet sign-with-keychain send
```
Faucets: the built-in one at https://docs.near.org/getting-started/faucet (testnet NEAR), or https://near-faucet.io/
(testnet NEAR + test FTs such as USDT). Mainnet accounts need real NEAR. Intents and Burrow have no usable testnet
(see the project research), so testnet is for vault-only flows.

## 2. Contracts
```bash
# deploy local wasm + init in one tx (cargo near builds to target/near/<crate>.wasm)
near contract deploy vault-dev.testnet use-file ./target/near/trellis_vault.wasm \
  with-init-call new json-args '{"owner":"alice.testnet"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
# (no init) ... use-file <wasm> without-init-call network-config testnet sign-with-keychain send
# cargo-near equivalent: cargo near deploy build-non-reproducible-wasm <acct> with-init-call new json-args '{...}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# global contracts (NEP-591): deploy once (BURNS 10 NEAR / 100 kB), then reference
near contract deploy-as-global use-file ./target/near/trellis_vault.wasm as-global-hash trellis-dev.testnet \
  network-config testnet sign-with-keychain send
near contract deploy-as-global use-file <wasm> as-global-account-id trellis-dev.testnet \
  network-config testnet sign-with-keychain send
near contract deploy some-acct.testnet use-global-hash <base58-code-hash> without-init-call network-config testnet sign-with-keychain send
near contract deploy some-acct.testnet use-global-account-id trellis-dev.testnet without-init-call network-config testnet sign-with-keychain send
# [VERIFY] whether `use-global-*` also accepts `with-init-call` like use-file does

# view (free, no signature)
near contract call-function as-read-only vault-dev.testnet get_status json-args '{}' network-config testnet now

# call with gas + deposit (owner methods need exactly 1 yocto)
near contract call-function as-transaction vault-dev.testnet withdraw_ft \
  json-args '{"token":"usdc.fakes.testnet","amount":"1000000"}' \
  prepaid-gas '50.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as alice.testnet network-config testnet sign-with-keychain send

# upgrade with raw wasm as input (contract reads env::input())
near contract call-function as-transaction vault-dev.testnet upgrade_with_code \
  file-args ./target/near/trellis_vault.wasm prepaid-gas '300.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as alice.testnet network-config testnet sign-with-keychain send

near contract view-storage vault-dev.testnet all as-text network-config testnet now   # dump raw state
```
- `prepaid-gas` max is **1000 Tgas** per transaction (was 300). Attach what the chain needs plus a margin, not the max.
- Deposit units: `'1 yoctoNEAR'`, `'0.01 NEAR'`, `'1 NEAR'`. Gas units: `'30.0 Tgas'`.
- JSON args: numbers above 2^53 as strings (`U128`).

## 3. Access keys (agent setup)
```bash
# function-call key on the AGENT account, restricted to one vault and its agent_* methods
near account add-key agent.trellis-dev.testnet grant-function-call-access \
  --allowance '0.5 NEAR' \
  --contract-account-id alice-testnet.trellis.testnet \
  --function-names 'agent_supply, agent_borrow, agent_repay, agent_swap_ref, sync_position' \
  autogenerate-new-keypair save-to-keychain \
  network-config testnet sign-with-keychain send
# or: ... use-manually-provided-public-key ed25519:<pk> network-config ...

# full-access key
near account add-key <acct> grant-full-access use-manually-provided-public-key ed25519:<pk> \
  network-config testnet sign-with-keychain send

# delete key(s)
near account delete-keys agent.trellis-dev.testnet public-keys ed25519:<pk> \
  network-config testnet sign-with-keychain send

near account list-keys agent.trellis-dev.testnet network-config testnet now
near generate-keypair print-to-terminal        # or: save-to-file ./key.json

# gas keys (NEP-611, live on mainnet protocol 86)
near account add-key <acct> grant-gas-key-full-access --num-nonces 8 autogenerate-new-keypair save-to-keychain \
  network-config testnet sign-with-keychain send
near account fund-gas-key <acct> ed25519:<pk> '5 NEAR' network-config testnet sign-with-keychain send
near account view-gas-key-nonces <acct> ed25519:<pk> network-config testnet now
near account withdraw-from-gas-key <acct> ed25519:<pk> '2 NEAR' network-config testnet sign-with-keychain send
# sign on a lane: ... sign-with-keychain --nonce-index 3 send
```
FC keys can't attach deposits. `--allowance` is a gas budget, and the key dies when it's spent.

## 4. Tokens and transactions
```bash
near tokens trellis-dev.testnet send-near alice.testnet '0.5 NEAR' network-config testnet sign-with-keychain send
near tokens trellis-dev.testnet view-near-balance network-config testnet now
near tokens alice.near view-ft-balance usdt.tether-token.near network-config mainnet now
near tokens alice.near send-ft wrap.near bob.near amount-ft '1 wNEAR' \
  prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' network-config mainnet sign-with-keychain send

# register an account on a token (NEP-145)
near contract call-function as-transaction usdt.tether-token.near storage_deposit \
  json-args '{"account_id":"alice-near.trellis.near","registration_only":true}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' sign-as alice.near network-config mainnet sign-with-keychain send

near transaction view-status <tx-hash> network-config testnet
```

## 5. Raw JSON-RPC
Endpoints (docs.near.org RPC providers; live 2026-10-22):
| Network | FastNEAR | Notes |
|---|---|---|
| mainnet | `https://free.rpc.fastnear.com` (also `https://rpc.mainnet.fastnear.com`) | archival is paid |
| testnet | `https://test.rpc.fastnear.com` (also `https://rpc.testnet.fastnear.com`) | |
Others: `https://archival-rpc.mainnet.near.org` (severely rate-limited), `https://near.drpc.org`, `https://rpc.intea.rs`.
Point the CLI at FastNEAR: `near config edit-connection testnet --key rpc_url --value https://test.rpc.fastnear.com`.

All queries are `POST` with `{"jsonrpc":"2.0","id":"x","method":...,"params":...}`.
Use `"finality":"final"` (or `"optimistic"`) **or** `"block_id"`.
```bash
RPC=https://free.rpc.fastnear.com
# account → {amount, locked, code_hash, storage_usage, storage_paid_at, block_hash, block_height}
# (global contract code: request_type "view_global_contract_code" + code_hash, or "view_global_contract_code_by_account_id")
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"x","method":"query",
 "params":{"request_type":"view_account","finality":"final","account_id":"wrap.near"}}'

# view function: args are base64 JSON; result is an array of bytes
ARGS=$(printf '{}' | base64)
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"x","method":"query",
 "params":{"request_type":"call_function","finality":"final","account_id":"wrap.near",
           "method_name":"storage_balance_bounds","args_base64":"'$ARGS'"}}' \
 | python3 -c 'import json,sys; print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'
# → {"min":"1250000000000000000000","max":"1250000000000000000000"}

# keys
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"x","method":"query",
 "params":{"request_type":"view_access_key_list","finality":"final","account_id":"agent.trellis.near"}}'
# single key: "request_type":"view_access_key", plus "public_key":"ed25519:..."

# tx status: method "tx" (or "tx_status"; "EXPERIMENTAL_tx_status" is a deprecated alias)
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"x","method":"tx",
 "params":{"tx_hash":"<hash>","sender_account_id":"<signer>","wait_until":"EXECUTED_OPTIMISTIC"}}'
# events live in result.receipts_outcome[*].outcome.logs ("EVENT_JSON:..."); check each outcome.status

# protocol limits (gas, storage price, log limits)
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"x","method":"EXPERIMENTAL_protocol_config","params":{"finality":"final"}}'
```
- Send signed txs with `send_tx` (`signed_tx_base64`, `wait_until`: `NONE` | `INCLUDED` | `EXECUTED_OPTIMISTIC` |
  `INCLUDED_FINAL` | `EXECUTED` | `FINAL`). `broadcast_tx_async/commit` are legacy.
- A tx "succeeded" only if **every relevant receipt** succeeded. The top-level `status` reflects the returned promise
  chain, so detached promises can fail silently. Inspect `receipts_outcome`.
- Frontend/worker RPC code (near-api-js, near-connect) → `near-frontend`, `near-ai-agent-infra` skills.

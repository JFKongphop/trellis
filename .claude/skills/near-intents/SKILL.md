---
name: near-intents
description: How to integrate NEAR Intents from a Rust NEAR contract (verifier intents.near, using auth-by-predecessor) and from TypeScript (1Click API, POA/Omni/HOT bridges). Covers deposits (ft_transfer_call with a DepositMessage), mt_transfer, mt_balance_of, ft_withdraw/mt_withdraw refund rules, 1Click quotes and how to verify the quote signature on-chain, funding an INTENTS-type quote from a contract, deposit addresses, omft/nep245/1cs_v1 token IDs, fees, and admin powers. Use it when code or questions mention NEAR Intents, intents.near, defuse, 1Click, solver, cross-chain swap, deposit address, omft, POA bridge, mt_transfer, ft_withdraw, execute_intents, or Earn receipt tokens.
---

# NEAR Intents integration (Rust contract + TypeScript)

Facts verified 2026-10-21/22 against source code, live mainnet views and live dry-run 1Click quotes. Anything not confirmed is marked **[VERIFY]**.

## Architecture in one screen

```
                 off-chain                                   on-chain (NEAR mainnet only)
 ┌────────────────────────────┐                  ┌──────────────────────────────────────────┐
 │ 1Click API                 │  quote → signed  │ intents.near  (the "Verifier", defuse     │
 │ 1click.chaindefuser.com/v0 │  depositAddress  │ 0.4.5): an internal NEP-245 ledger.       │
 │  /tokens /quote /status    │ ───────────────► │  token ids: nep141:<ft>, nep245:<mt>:<id> │
 │  /deposit/submit           │                  │  auth: signed intents (execute_intents)   │
 │  /generate-intent          │  solvers fill    │        OR predecessor (direct calls)      │
 │  /submit-intent  /orders   │ ◄──────────────► │  ft_on_transfer = deposit                 │
 └────────────────────────────┘                  │  mt_transfer / ft_withdraw / mt_withdraw  │
 ┌────────────────────────────┐                  └──────────────────────────────────────────┘
 │ Bridges (mint/burn *.omft.near, nep245 HOT, Omni)  ◄── ft_withdraw(token, receiver=token,
 │ POA: bridge.chaindefuser.com/rpc  deposit_address        memo="WITHDRAW_TO:<addr>")
 └────────────────────────────┘
```

- **Verifier `intents.near`** holds every user's balances as NEP-245 multi-tokens. A contract (such as our vault) becomes an Intents account the first time someone credits it. It then calls `mt_transfer`, `ft_withdraw` and the rest **directly**. The verifier authenticates the call by `predecessor_account_id`, which is on by default for every account. No keys and no signatures are involved.
- **1Click** is a centralized REST service. It gets quotes from solvers, hands out a one-time `depositAddress`, and settles once funds arrive there. Quotes are ed25519-signed by 1Click.
- **Bridges** turn foreign-chain assets into NEP-141 tokens (`btc.omft.near`, `eth-0x…omft.near`, `nep245:v2_1.omni.hot.tg:…`, `nbtc.bridge.near`) credited inside Intents.

## Critical safety rules (do not break)

1. **Never call `intents.near add_public_key` from a vault/contract, and never register the agent's key.** Every registered key can sign *any* intent for that account: transfers, withdrawals to any address, and adding more keys. That gives it unrestricted control of the Intents balance. Auth-by-predecessor already lets the contract act. Our vault never uses signed intents. In tests, assert `public_keys_of(vault) == []`.
2. **Never call `disable_auth_by_predecessor_id`** on a contract account. With no keys registered, that locks the funds forever.
3. **Withdraw without `msg`.** `ft_withdraw`/`mt_withdraw` with `msg: None` uses `ft_transfer`, so a failed transfer re-credits the Intents balance. Any `msg`, including `""`, uses `ft_transfer_call` and is **not refunded** on failure. The receiver must be storage-registered on the token.
4. **There is no testnet** ("no testnet deployment and no plans for one", FAQ). Use a local sandbox with mocks, then mainnet with small amounts ($20–50). Never send funds from tooling or agents without an explicit human decision.
5. **Agent routing through 1Click must check a 1Click-signed quote on-chain.** The vault must confirm that `recipient == refundTo == vault` and that all three types are `INTENTS` before it moves funds to an opaque `depositAddress`. See `references/one-click-api.md` §Signature.
6. **Do not send native NEAR to `intents.near`.** Wrap it to wNEAR first. The contract also has no direct `native_withdraw` method; that exists only as a signed intent.
7. Treat 1Click, the bridges and the Intents DAO as **trusted third parties**. Disclose their admin powers (see `references/bridges-and-tokens.md` §Centralization). Bound your exposure with caps.

## Most common mistakes

| Mistake | Fix |
|---|---|
| Token ID prefix wrong | `mt_*` methods, `transfer`/`token_diff` intents and 1Click `assetId` use `nep141:wrap.near`. `ft_withdraw`'s `token` arg and withdraw intents use the bare `wrap.near`. |
| `msg: ""` on withdraw ("empty is like none") | Omit `msg` / pass `None`. |
| Funding an `INTENTS` quote with `ft_transfer` to the depositAddress | `INTENTS` quotes are funded **inside** Intents: `intents.near mt_transfer(receiver_id=depositAddress, token_id="nep141:…", amount)` with 1 yocto. A plain `ft_transfer` only fits `ORIGIN_CHAIN` quotes whose origin asset is a NEAR NEP-141. |
| Hashing the raw 1Click response to verify it | 1Click signs `base58(sha256(stableStringify({…subset of quoteRequest, …subset of quote, timestamp})))`. Rebuild that subset exactly, or have the agent pass the canonical string. |
| Assuming the quote echoes your asset IDs back | 1Click may normalize them. `nep141:btc.omft.near` with `ORIGIN_CHAIN` came back as `1cs_v1:btc:native:coin`. Compare against the **signed** values. |
| `DESTINATION_CHAIN` delivery to a NEAR account that does not exist or is not registered | Live dry quote → HTTP 400 "Internal server error". Use `recipientType: INTENTS` for the vault, then `ft_withdraw`. |
| Forgetting 1 yocto | `mt_transfer`, `mt_batch_transfer`, `ft_withdraw`, `mt_withdraw`, `add/remove_public_key` and `disable_auth_by_predecessor_id` all call `assert_one_yocto()`. |
| `mt_transfer` to self or with amount 0 | `InvalidIntent` panic (sender == receiver or a zero amount). |
| Expecting `ft_withdraw` to `storage_deposit` for you | The direct method always passes `storage_deposit: None`. Only the signed `ft_withdraw` intent has that option. Register storage yourself first. |
| Requesting quotes without a partner key in production | You pay an extra fee (docs: +25 bps). Get a key at partners.near-intents.org and send `X-API-Key: <JWT>`. |
| Treating `/v0/status = SUCCESS` as settlement | The contract settles from `mt_balance_of` / `ft_balance_of` deltas, never from the API. |

## Reference index

- `references/verifier-contract.md`: every `intents.near` method a contract uses, with exact args, deposit/gas, refund behavior and Rust `ext_contract` snippets that compile (near-sdk 5.29.1). Also the signed-intent format (NEP-413, versioned nonce, `current_salt`), simulation, and roles/admin.
- `references/one-click-api.md`: base URL, auth, every endpoint, every quote field and enum, real dry-run request/response pairs, **exactly what the quote signature covers plus 1Click's public key**, a Rust verifier tested against a live quote, how a contract funds an `INTENTS` quote, and TypeScript with `@defuse-protocol/one-click-sdk-typescript@0.1.26`.
- `references/bridges-and-tokens.md`: the POA bridge JSON-RPC (`supported_tokens`, `deposit_address`, `recent_deposits`, `withdrawal_status`, `withdrawal_estimate`), how to withdraw to a foreign chain, Omni and HOT in brief, key token IDs, Earn receipt tokens, fees, minimums, latencies, and centralization disclosures.

## Trellis vault quick recipe

- **Inbound funding** (BTC/ETH/SOL/USDC from another chain → vault). Request a 1Click quote with `recipient = <vault>`, `recipientType = INTENTS`, `depositType = ORIGIN_CHAIN`, `refundTo` = the user's address on the origin chain. Alternatively, POA `deposit_address({account_id: <vault>, chain})`. Funds land in the vault's Intents balance. The vault then calls `ft_withdraw(token, vault, amt, None, None)`.
- **Agent-routed swap/yield.** The agent passes `(signed_quote_json, signature)`. The vault:
  1. verifies the signature;
  2. checks `dry == false`, `swapType == EXACT_INPUT`, all three types `INTENTS`, `recipient == refundTo == vault`, assets allowlisted, `amountIn` within caps, `minAmountOut` against the oracle, freshness, and that the quote hash is unused;
  3. calls `mt_transfer(depositAddress, "nep141:<in>", amountIn)`;
  4. settles later from `mt_batch_balance_of(vault, [in, out])`;
  5. calls `ft_withdraw` with no `msg`.

## Sources (fetched 2026-10-21/22)

- github.com/near/intents. Clone at `d340060` (2026-10-21). Deployed `intents.near` reports `contract_source_metadata` version 0.4.5, rev `16d04f6ec4401263f8914638710260da50bb46b0` (not present in the shallow clone; same crate version). Read: `contracts/defuse/src/{tokens,accounts,intents,salts,fees}.rs`, `contract/tokens/nep141/{deposit,withdraw}.rs`, `contract/tokens/nep245/core.rs`, `contract/accounts/mod.rs`, `core/src/intents/tokens.rs`, `crates/signatures/nep413`, `contracts/defuse/README.md#nonces`.
- docs.near-intents.org: verifier-contract/{deposits, withdrawals, balances, account-abstraction, signing-intents, intent-types-and-execution}; 1click-api/{authentication, quickstart/*, swap-types, verify-quote-signature, earn, fee-config, orders, sdk}; resources/{fees, faqs}; bridging/overview; learn/omni-bridge/overview; changelog (2026-06-27 Verify Quote Signatures; 2026-09-09/14 temporary minimums).
- 1Click OpenAPI `https://1click.chaindefuser.com/docs/v0/openapi.yaml` (info.version 0.1.10).
- npm `@defuse-protocol/one-click-sdk-typescript@0.1.26` (`dist/index.mjs`, "src/quote-signature.ts"); `@defuse-protocol/internal-utils@0.43.0` (poaBridgeHttpClient); `@defuse-protocol/intents-sdk@0.92.0` (poa-bridge-utils, omni-bridge-constants).
- github.com/NEAR-DevHub/trezu (release-1.31.1): `nt-fe/lib/near-proposal-builders.ts` `buildIntentsTransferProposal`. This is a production example of a contract account (a Sputnik DAO) funding `INTENTS` quotes with `mt_transfer`.
- Live: `/v0/tokens`; dry `/v0/quote` (signatures verified with the SDK and independently in Python and Rust); `bridge.chaindefuser.com/rpc supported_tokens`; RPC views on `intents.near` and `omft.near` (`current_salt`, `fee`, `acl_*`, access keys).

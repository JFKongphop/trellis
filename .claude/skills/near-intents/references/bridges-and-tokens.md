# Bridges, token IDs, fees and trust model

Docs: docs.near-intents.org/integration/bridging/overview, /learn/omni-bridge/overview, /resources/fees, /resources/faqs, /security-compliance/treasury-addresses. Clients: `@defuse-protocol/internal-utils@0.43.0` (`poaBridge/poaBridgeHttpClient`) and `@defuse-protocol/intents-sdk@0.92.0` (`bridges/*`). Live calls on 2026-10-21.

## 1. Which bridge serves which chain (docs, "Token Bridges")

| Bridge | Route ID | Chains | Token form inside Intents |
|---|---|---|---|
| **POA Bridge** (Proof of Authority, run by the Intents team) | `poa_bridge` | Ethereum, Base, Arbitrum, Gnosis, Berachain, Bitcoin, BCH, Litecoin, Dogecoin, Solana, XRP, Zcash, Tron, Sui, Aptos, Cardano, Starknet | `nep141:<chain>-<addr>.omft.near` / `nep141:<chain>.omft.near` (also some `*.omdep.near`) |
| **Omni Bridge** (Near One; light clients / Wormhole in, MPC signatures out) | `omni_bridge` | Ethereum, Base, Arbitrum, BNB, Solana, Bitcoin | `nep141:eth.bridge.near`, `nep141:nbtc.bridge.near`, `nep141:<addr>.factory.bridge.near`, and others |
| **HOT Bridge** (HOT/Omni protocol) | `hot_bridge` | BNB, Polygon, Optimism, Avalanche, Scroll, Monad, TON, Stellar, LayerX, Adi, Plasma | `nep245:v2_1.omni.hot.tg:<chainId>_<id>` |

For most integrations, **1Click hides the choice of bridge**: request a quote with `depositType: ORIGIN_CHAIN` and the right `originAsset`. Use the bridges directly only for plain deposit addresses (no swap) or for withdrawals.

## 2. POA bridge JSON-RPC: `POST https://bridge.chaindefuser.com/rpc`

Body: `{"id":"<any>","jsonrpc":"2.0","method":"<m>","params":[{…}]}`. The SDK also appends `?method=<m>` to the URL. Errors come back as `{"error":"<string>"}`. Method names and types come from `internal-utils` `apis.js`/`types.d.ts`.

| Method | Params | Result |
|---|---|---|
| `supported_tokens` | `{chains?: string[]}` (e.g. `["btc:mainnet","eth:8453"]`) | `{tokens:[{intents_token_id, standard, near_token_id, multi_token_id?, asset_name, decimals, min_deposit_amount, min_withdrawal_amount, withdrawal_fee, defuse_asset_identifier (deprecated), origin_chain_address \| "native"}]}`. 242 entries live. |
| `deposit_address` | `{account_id, chain, deposit_mode?: "SIMPLE"\|"MEMO"}` | `{address, chain, memo?}`. Each Intents account gets its own address per chain. **Not called in research** (it may create a server-side record). |
| `recent_deposits` | `{account_id, chain?, status?, limit?, offset?}` | `{deposits:[{tx_hash, chain, defuse_asset_identifier, near_token_id, decimals, amount, account_id, address, status: "COMPLETED"\|"PENDING"\|"FAILED"\|"CREDITED"}], total, limit, offset, hasMore}` (live returned `hasMore`) |
| `withdrawal_status` | `{withdrawal_hash: <NEAR tx hash>}` | `{withdrawals:[{status:"COMPLETED"\|"PENDING", data:{tx_hash, transfer_tx_hash, chain, …, amount, account_id, address, created}}]}` |
| `withdrawal_estimate` | `{token, address, chain}` | `{token, tokenAddress, userAddress, withdrawalFee, withdrawalFeeDecimals}` |
| `hot_omni_withdraw` | `{account_id, tx_hash, receiver, chain_id}` | HOT withdrawal status |

`chain` strings (intents-sdk `poa-bridge-utils`): `eth:1`, `eth:8453` (Base), `eth:42161` (Arb), `eth:100` (Gnosis), `eth:80094` (Bera), `btc:mainnet`, `bch:mainnet`, `doge:mainnet`, `ltc:mainnet`, `xrp:mainnet`, `tron:mainnet`, `sui:mainnet`, `cardano:mainnet`, `zec:mainnet`, `sol:mainnet`, `aptos:mainnet`, and others.

**Vault funding with POA:** `deposit_address({account_id: "<vault>", chain: "btc:mainnet"})`. The user sends BTC there. After confirmations, `btc.omft.near` is credited to the vault's Intents balance. The FAQ allows "an account that hasn't yet been connected… requires caution". Very small BTC UTXOs (about 5,000 sats) count as dust and are swept late. A stuck BTC deposit has its own refund guide (`/integration/bridging/btc-deposit-refund`).

**Withdraw to a foreign chain via POA** (intents-sdk `createWithdrawIntentPrimitive`):

```json
{"intent":"ft_withdraw","token":"btc.omft.near","receiver_id":"btc.omft.near","amount":"<sats>",
 "memo":"WITHDRAW_TO:<destination address>[:<xrp memo>]","min_gas":"17050000000000"}
```

A contract can make the same call directly: `intents.near ft_withdraw(token="btc.omft.near", receiver_id="btc.omft.near", amount, memo=Some("WITHDRAW_TO:bc1…"), msg=None)` with 1 yocto. BCH addresses drop the `bitcoincash:` prefix. Track it with `withdrawal_status({withdrawal_hash: <NEAR tx hash>})`. For the Trellis vault, **foreign-chain withdrawals should be owner-only, to an owner-set address**. The agent must never choose a `WITHDRAW_TO` address.

## 3. Omni and HOT in brief

- **Omni** (intents-sdk `omni-bridge-utils`): a withdrawal is a signed `ft_withdraw` intent to `receiver_id: "omni.bridge.near"` with `msg: JSON{recipient:"<chain>:<addr>", fee:"0", native_token_fee, external_id}`. It is often preceded by a `storage_deposit` intent on `omni.bridge.near`. **It uses `msg`, so a failure isn't refunded by the verifier.** `MIN_GAS_AMOUNT` is 37.4 TGas. Fees come from the Omni relayer API (`native_token_fee`). Inbound proofs are checked by light clients (BTC, ETH) or Wormhole (Solana, L2s). Outbound needs threshold-MPC signatures from NEAR Chain Signatures nodes. BTC deposit addresses are derived per deposit, and coins stay at that address until spent.
- **HOT**: tokens are NEP-245 on `v2_1.omni.hot.tg`. Withdrawals are `mt_withdraw` intents built by HOT's SDK (`buildGaslessWithdrawIntent`), 91.3 TGas min gas. The POA RPC method `hot_omni_withdraw` reports status. HOT's treasury addresses appear on the docs' treasury page.
- **No direct contract path needed for Trellis.** Use 1Click for anything cross-chain, and keep the vault's own Intents operations to `mt_transfer` and `ft_withdraw` to itself.

## 4. Key token IDs (live `/v0/tokens` and POA `supported_tokens`, 2026-10-21)

| Asset | Intents token ID (`mt_*`, 1Click) | Contract for `ft_withdraw` | Decimals |
|---|---|---|---|
| wNEAR | `nep141:wrap.near` | `wrap.near` | 24 |
| USDC (native NEAR, Circle) | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | same hex account | 6 |
| USDT (native NEAR, Tether) | `nep141:usdt.tether-token.near` | `usdt.tether-token.near` | 6 |
| stNEAR (Meta Pool) | `nep141:meta-pool.near` | | 24 |
| RHEA | `nep141:token.rhealab.near` | | 18 |
| BTC (POA) | `nep141:btc.omft.near` (1Click may show `1cs_v1:btc:native:coin` for origin-chain BTC) | `btc.omft.near` | 8 |
| BTC (Omni) | `nep141:nbtc.bridge.near` | `nbtc.bridge.near` | 8 |
| ETH on Ethereum (POA) | `nep141:eth.omft.near` | | 18 |
| ETH (Omni / Rainbow on NEAR) | `nep141:eth.bridge.near` | | 18 |
| ETH on Base / Arb | `nep141:base.omft.near` / `nep141:arb.omft.near` | | 18 |
| SOL | `nep141:sol.omft.near` | | 9 |
| ZEC | `nep141:zec.omft.near` | | 8 |
| USDC Ethereum | `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near` | | 6 |
| USDC Base | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | | 6 |
| USDC Arbitrum | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` | | 6 |
| USDC Solana | `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near` | | 6 |
| USDT Ethereum / Tron / Solana | `nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near` / `nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near` / `nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near` | | 6 |
| USDC Polygon (HOT) | `nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L` | `mt_withdraw(token="v2_1.omni.hot.tg", token_ids=["137_qiSt…"])` | 6 |
| USDC BSC (HOT) | `nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r` | | **18** |

Always resolve IDs from `GET /v0/tokens` at build time. Don't hardcode symbols: there are several "USDC" and "BTC" entries. Same symbol, different decimals (USDC on BSC has 18).

### Earn receipt tokens (docs `1click-api/earn`; present in live `/v0/tokens`)

| Symbol | Protocol | Chain | Dec | assetId |
|---|---|---|---|---|
| `gtUSDCp` | Gauntlet USDC Prime (Morpho) | base | 18 | `nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near` |
| `TLO` | Taler USDC | eth | 8 | `nep141:eth-0x0f38f1ce62776d4a0038bc6cac66877a5687383b.omft.near` |
| `kV-gtSOLb` | Kamino SOL | sol | 9 | `nep141:sol-0xa69aa1bcb03a369e338156a8718ad60271145803.omdep.near` |

- Deposit = a normal quote with `destinationAsset` = the receipt token. Withdraw = the reverse. `recipientType: INTENTS` keeps the shares in Intents, which suits the vault.
- A live dry quote of 20 NEAR-USDC → `gtUSDCp` with INTENTS/INTENTS returned `timeEstimate: 25`.
- The `/v0/tokens` `price` for `gtUSDCp` is per base unit and looks odd (`1.11e-6`). Value positions from a quote back to USDC (dry `EXACT_INPUT`), not from `price × balance`.
- "NEAR Intents does not run these yield protocols, set their APY, or guarantee principal." Listings and liquidity can change, and a quote may fail with `No liquidity available`.

## 5. Fees, minimums, latencies

- **Protocol fee:** 1 pip = 0.0001% (live `intents.near fee()` → `1`), on intent execution. Collector: `7066024d…7f05`.
- **1Click:** with an API key, 20 bps normally and 1 bp for stablecoin or same-asset routes. Without a key the docs say +25 bps (see one-click-api.md §1 on the observed echo). Partner `appFees` are split 50/50 with a 20 bps floor for 1Click. The positive slippage between quote and fill is split 50/50 (within about 30 min). `insured: true` adds 2 bps.
- **Withdrawal fees:** 0.1% for NEAR, ZEC and STRK withdrawn to Solana. POA `withdrawal_fee` per token, in base units, live examples:

| Token | min_deposit | min_withdrawal | withdrawal_fee |
|---|---|---|---|
| BTC (`btc.omft.near`) | 5,000 sats | 700 sats | 1,500 sats |
| ETH on Ethereum | 1e11 wei | 1 | 3.5e13 wei (0.000035 ETH) |
| USDC Ethereum | 0.001 | 0.000001 | 0.30 USDC |
| USDC Base | 0.15 | 0.000001 | 0.0024 USDC |
| USDC Arbitrum | 0.001 | 0.000001 | 0.0053 USDC |
| USDC Solana | 0.001 | 0.000001 | 0.03 USDC |
| SOL | 0.00125 | 0.00125 | 0.000014 SOL |
| USDT Tron | 1 USDT | 1 USDT | 1 USDT |
| NEAR-native (wNEAR, USDC, USDT) | 1 base unit | 1 | 0 |

- **Quote-side refund fees** (live): `refundFee` 2,400 (0.0024 USDC) for Base USDC, 1,900 sats for BTC, and 0 inside Intents.
- **Temporary minimums:** origin→origin swaps under $1,000 are blocked on BSC, POL, TON, OP, AVAX, XLM, MON, XLayer and ADI, and under $100 from Tron. Deposits to and withdrawals from Intents are unaffected.
- **Latency** (`timeEstimate` seconds, live): Intents↔Intents swap ~10; Base USDC → Intents ~35; Intents → Earn on Base ~25; BTC origin → NEAR ~805 (BTC confirmations; set `deadline` ≥ 1 h for BTC). Expect 20–60 s for EVM/Solana routes.

## 6. Centralization and admin powers to disclose

| Component | Who controls it | Power |
|---|---|---|
| `intents.near` (Verifier) | DAO role `intents.sputnik-dao.near` (also a super admin with `intents.near`); Upgrader `ctl-intents.near`; PauseManagers (6 implicit accounts + `pm.bridge.near`); UnrestrictedAccountLocker (one implicit account) | Upgrade code, pause, **lock any account**, **force-withdraw / force-transfer any balance** (`*_force_*`, DAO or UnrestrictedWithdrawer), toggle anyone's predecessor auth, set fees and fee collector, rotate salts. No full-access keys on the account (only function-call relayer keys). |
| POA tokens `*.omft.near` (factory `omft.near`) | Super admins `omft.near`, `intents.sputnik-dao.near`; TokenDeployer `bridge-mng.near`, `int-dpl-dao.sputnik-dao.near`; TokenDepositer (mint) `bridge-mng.near`, `int-mnt-dao.sputnik-dao.near` | Mint (`ft_deposit`) bridged tokens; deploy tokens; pause. Foreign-chain custody sits with the POA operators (treasury addresses are on the docs page). A POA token is an IOU of that operator. |
| 1Click | Defuse/NEAR Intents team (off-chain) | Picks solvers, holds the `depositAddress` accounts, decides settlement and refunds, signs quotes (`ed25519:reYaWhvw…Vifc`). Can refuse or delay service. Its terms of service apply. |
| Omni Bridge | Near One; NEAR MPC network for outbound | Bridge contract upgrades and MPC signing. Light-client/Wormhole trust on inbound. |
| HOT Bridge | HOT team (`v2_1.omni.hot.tg`) | Mint/burn of nep245 tokens; HOT treasury custody. |
| Proactive security / Shield | Intents security team | Can flag and lock suspicious flows (docs "Proactive Intents Security", Shield Incident API changelog 2026-07-03). |

These are the bridges' published or on-chain roles as of 2026-10-21 (`acl_get_super_admins`, `acl_get_grantees`). Re-query them before the demo, since roles can change. Audits: Google Drive folder linked from `/security-compliance/security`. Bug bounty on HackenProof (`near-intents`).

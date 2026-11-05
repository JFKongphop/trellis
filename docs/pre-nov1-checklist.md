# Pre-Nov 1 checklist

Goal: confirm the risky assumptions with real (tiny) transactions before the build starts, and get keys/accounts ready.
These are manual tests from a normal wallet account. They are not project code.

**Budget:** ~5 NEAR (~$27). Expected cost after you withdraw everything: under $1 (swap fees, Intents fee, gas, ~0.15 NEAR Burrow storage which you can reclaim).
**Time:** ~2 hours.

Record every tx hash and result in the table at the bottom. Check every tx on https://nearblocks.io: a tx can show "success" while an inner step failed, so open the receipts.

---

## 0. Tools (no money)

```bash
npm install -g near-cli-rs@latest          # binary: near
rustup target add wasm32-unknown-unknown   # needed to build contracts / the mock oracle
cargo install cargo-near --version 0.22.0
near --version && cargo near --version
```
- [ ] All three installed.

## 1. Test account (mainnet)

Use a **separate** account, not your main wallet. Create it in HOT or Meteor wallet, fund it with 5 NEAR, then import it into the CLI:

```bash
near account import-account using-web-wallet network-config mainnet
export T=<your-test-account>.near
export USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
near account view-account-summary $T network-config mainnet now
```
- [ ] `$T` exists with ~5 NEAR.

## 2. Wrap NEAR and register on USDC

```bash
# register on wrap.near and USDC (0.00125 NEAR each)
near contract call-function as-transaction wrap.near storage_deposit json-args '{"account_id":"'$T'","registration_only":true}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' sign-as $T network-config mainnet sign-with-keychain send
near contract call-function as-transaction $USDC storage_deposit json-args '{"account_id":"'$T'","registration_only":true}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' sign-as $T network-config mainnet sign-with-keychain send

# wrap 3 NEAR → 3 wNEAR
near contract call-function as-transaction wrap.near near_deposit json-args '{}' \
  prepaid-gas '30.0 Tgas' attached-deposit '3 NEAR' sign-as $T network-config mainnet sign-with-keychain send
near tokens $T view-ft-balance wrap.near network-config mainnet now
```
- [ ] 3 wNEAR in `$T`.

## 3. Ref swap, deposit → swap → withdraw (tests vault spec §6.3)

Proves: pool 4512 works, `swap` needs no 1 yocto and returns the amount out, `withdraw` amount `"0"` means "all".

```bash
REF=v2.ref-finance.near
near contract call-function as-transaction $REF storage_deposit json-args '{"account_id":null,"registration_only":false}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0.01 NEAR' sign-as $T network-config mainnet sign-with-keychain send
near contract call-function as-transaction $REF register_tokens json-args '{"token_ids":["wrap.near","'$USDC'"]}' \
  prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send

# quote 1 wNEAR → USDC (6 decimals)
near contract call-function as-read-only $REF get_return json-args \
  '{"pool_id":4512,"token_in":"wrap.near","amount_in":"1000000000000000000000000","token_out":"'$USDC'"}' network-config mainnet now
export MIN_OUT=<99% of the number above>

# deposit 1 wNEAR into Ref (msg "" = deposit only)
near contract call-function as-transaction wrap.near ft_transfer_call \
  json-args '{"receiver_id":"'$REF'","amount":"1000000000000000000000000","msg":""}' \
  prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send

# swap with ZERO deposit (checks the "no 1 yocto" finding)
near contract call-function as-transaction $REF swap json-args \
  '{"actions":[{"pool_id":4512,"token_in":"wrap.near","amount_in":"1000000000000000000000000","token_out":"'$USDC'","min_amount_out":"'$MIN_OUT'"}]}' \
  prepaid-gas '50.0 Tgas' attached-deposit '0 NEAR' sign-as $T network-config mainnet sign-with-keychain send
# → note the returned amount

# withdraw all USDC from Ref (amount "0" = all)
near contract call-function as-transaction $REF withdraw json-args '{"token_id":"'$USDC'","amount":"0","skip_unwrap_near":true}' \
  prepaid-gas '50.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send
near tokens $T view-ft-balance $USDC network-config mainnet now
```
- [ ] `swap` succeeded with 0 deposit and returned `amount_out ≥ MIN_OUT`.
- [ ] `withdraw "0"` delivered all of it. Record the gas burnt per step (for the vault's gas constants).
- [ ] Optional: repeat the swap with `min_amount_out` set 5% above the quote → it must fail and the wNEAR must stay in your Ref deposit (`get_deposits`). Then withdraw it.

## 4. Burrow supply → borrow → repay → withdraw (tests vault spec §6.1, §6.2)

```bash
B=contract.main.burrow.near
near contract call-function as-transaction $B storage_deposit json-args '{"account_id":null,"registration_only":false}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0.15 NEAR' sign-as $T network-config mainnet sign-with-keychain send

# supply 1.5 wNEAR as collateral (msg is a JSON string, quotes included)
near contract call-function as-transaction wrap.near ft_transfer_call \
  json-args '{"receiver_id":"'$B'","amount":"1500000000000000000000000","msg":"\"OnlyIncreaseCollateral\""}' \
  prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send
near contract call-function as-read-only $B get_account_all_positions json-args '{"account_id":"'$T'"}' network-config mainnet now

# borrow 1 USDC and withdraw it to the wallet. Inner decimals: 1 USDC = 1e18.
near contract call-function as-transaction $B execute_with_pyth json-args \
  '{"actions":[{"Borrow":{"token_id":"'$USDC'","amount":"1000000000000000000"}},{"Withdraw":{"token_id":"'$USDC'","max_amount":"1000000000000000000"}}]}' \
  prepaid-gas '300.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send
near contract call-function as-read-only $B get_account_all_positions json-args '{"account_id":"'$T'"}' network-config mainnet now
near tokens $T view-ft-balance $USDC network-config mainnet now
```
- [ ] Positions shape is `positions.REGULAR.{collateral,borrowed}` with `{token_id, balance, shares, apr}`.
- [ ] Borrow arrived (expect ~0.999999 USDC, 1 unit short). Open the tx on nearblocks: note the oracle calls and the gas of each receipt.

```bash
# repay with a small overpay (1.1 USDC); the remainder should land as plain "supplied"
near contract call-function as-transaction $USDC ft_transfer_call \
  json-args '{"receiver_id":"'$B'","amount":"1100000","msg":"\"OnlyRepay\""}' \
  prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send
near contract call-function as-read-only $B get_account_all_positions json-args '{"account_id":"'$T'"}' network-config mainnet now

# debt is 0 → withdraw leftover USDC and all collateral without prices
near contract call-function as-transaction $B execute json-args \
  '{"actions":[{"Withdraw":{"token_id":"'$USDC'"}},{"DecreaseCollateral":{"token_id":"wrap.near"}},{"Withdraw":{"token_id":"wrap.near"}}]}' \
  prepaid-gas '150.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send
```
- [ ] Debt is 0 after repay; the overpay showed up as `supplied` (confirms the reconcile rule).
- [ ] Everything came back. If `execute` fails because a tiny debt remains, repay another 0.01 USDC and retry.

## 5. NEAR Intents: deposit → INTENTS quote → mt_transfer → withdraw (tests vault spec §6.4)

Proves: the deposit-address format, funding via `mt_transfer`, and refundable withdraw. Uses ~2 USDC.

```bash
# deposit 2 USDC into your Intents balance
near contract call-function as-transaction $USDC ft_transfer_call \
  json-args '{"receiver_id":"intents.near","amount":"2000000","msg":""}' \
  prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send
near contract call-function as-read-only intents.near mt_balance_of json-args '{"account_id":"'$T'","token_id":"nep141:'$USDC'"}' network-config mainnet now

# real (dry:false) quote, everything inside Intents. Set the deadline ~30 min ahead.
curl -s https://1click.chaindefuser.com/v0/quote -H 'content-type: application/json' -d '{
  "dry":false,"swapType":"EXACT_INPUT","slippageTolerance":100,
  "originAsset":"nep141:'$USDC'","depositType":"INTENTS",
  "destinationAsset":"nep141:wrap.near","amount":"2000000",
  "refundTo":"'$T'","refundType":"INTENTS","recipient":"'$T'","recipientType":"INTENTS",
  "deadline":"<ISO time ~30 min from now, e.g. 2026-10-25T12:30:00Z>"}' | tee /tmp/quote.json
export DEP=<quote.depositAddress>
```
- [ ] Record the `depositAddress` format (64-hex implicit account expected).
- [ ] Optional: verify the quote signature with the helper in the `near-intents` skill (`references/one-click-api.md` §6).

```bash
# fund the quote by transferring inside Intents
near contract call-function as-transaction intents.near mt_transfer \
  json-args '{"receiver_id":"'$DEP'","token_id":"nep141:'$USDC'","amount":"2000000"}' \
  prepaid-gas '50.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send
curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=$DEP"     # repeat until SUCCESS / REFUNDED
near contract call-function as-read-only intents.near mt_balance_of json-args '{"account_id":"'$T'","token_id":"nep141:wrap.near"}' network-config mainnet now

# withdraw the wNEAR back to your account. NO msg field → refundable if it fails.
near contract call-function as-transaction intents.near ft_withdraw \
  json-args '{"token":"wrap.near","receiver_id":"'$T'","amount":"<balance from above>"}' \
  prepaid-gas '50.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send
```
- [ ] Status reached `SUCCESS` and the output landed in your Intents balance.
- [ ] `ft_withdraw` delivered it. Note the time from funding to success and the fee taken.

## 5b. Cross-chain funding card (real money, about $20)

Tests the web app's "Fund from another chain" card (frontend-spec §4.7). Do it from the vault page once the vault exists, or with "To your wallet".
1. Pick **USDC on Base**, amount **20**, receive **USDC**, and paste your Base address as the refund address. The preview should show about 19.99 USDC and a fee of a few cents.
2. Click **Get deposit address**. Send exactly 20 USDC on Base to that address from your Base wallet (MetaMask etc.), within the time shown.
3. Watch the status bar: Waiting → Deposit seen → Swapping → Arrived (about 1 minute). Optionally paste the Base tx hash.
4. Check the vault (or wallet) USDC balance went up by about 19.99, and that the NEAR tx link opens on nearblocks.
5. Note anything that looked wrong in Results below.

## 6. Clean up

```bash
near tokens $T view-ft-balance wrap.near network-config mainnet now
near contract call-function as-transaction wrap.near near_withdraw json-args '{"amount":"<wNEAR balance>"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $T network-config mainnet sign-with-keychain send
```
- [ ] Leftover USDC can stay; we'll reuse it for the demo.

## 7. Sandbox borrow test (no money)

After step 0, ask Claude to run the sandbox borrow flow from the `near-contract-testing` skill (`mainnet-contracts-in-sandbox.md` §6) with a mock oracle that honors price age.
- [ ] Borrow works in the sandbox with the mock oracle at `aggregate-oracle.near`.

## 8. Keys and accounts

- [ ] **NEAR Intents partner JWT**: https://partners.near-intents.org/ (lowers 1Click fees).
- [ ] **NEAR AI Cloud API key**: sign up via https://docs.near.ai/cloud/quickstart.
- [ ] **Mainnet account names** for the project: factory (e.g. `trellis.near`) and agent (e.g. `agent.trellis.near`). Check they're free.
- [ ] **X account** for the required demo post.
- [ ] **GitHub repo** created (must be public by Nov 14).

## 9. Ask the organizers (NEAR Discord, https://discord.gg/nearprotocol)

> Hi! For NEAR Hackathon (Nov 1–14): can we port and extend a project we built earlier on another chain (Sprout, an AI DeFi agent on Sui) if the NEAR version (contracts, integrations) is built during the hackathon? Or must the repo start from scratch on Nov 1?

- [ ] Answer received: ______

## Results

| Check | Tx hash / result | Gas burnt | Notes |
|---|---|---|---|
| Ref swap (0 deposit) | | | |
| Ref withdraw "0" | | | |
| Burrow supply | | | |
| Burrow borrow | | | |
| Burrow repay overpay | | | |
| Burrow withdraw all | | | |
| Intents deposit | | | |
| Intents depositAddress format | | | |
| Intents mt_transfer → SUCCESS | | | time: |
| Intents ft_withdraw | | | |

# Ref / Rhea classic pools — `v2.ref-finance.near`

Checked 2026-10-22. Live contract: `version` = **"1.9.20"**, code hash `25eNFdfK76NUEZn4cDgq1xQYKjxKCuzgXmPB3SHBRW4Y`, `metadata.state` = `"Running"`, owner `ref-finance.sputnik-dao.near`, `pool_count` 8979, `admin_fee_bps` 2000, `wnear_id` `wrap.near`.

**About the source.** The official repo `github.com/ref-finance/ref-contracts` (linked from the official guide's `developers/contracts.md`) returns **404** today, so it is private or deleted. The code shapes below come from an **unofficial copy** of v1.9.18 (`DevOfCredit/ref-contracts`, commit `b444323`, `ref-exchange/Cargo.toml` version 1.9.18). I checked them against the **live 1.9.20 wasm export list**. Every method named here is still exported on mainnet: `swap`, `swap_by_output`, `execute_actions`, `execute_actions_in_va`, `withdraw`, `register_tokens`, `get_pool`, `get_return`, `predict_swap_actions`, and the rest. I also checked them against live view calls and real mainnet transactions. Argument-level changes between 1.9.18 and 1.9.20 have not been confirmed **[VERIFY: before mainnet, confirm the behaviour with a sandbox fork or a small real tx]**.

---

## 1. Account setup (one time, done by the vault itself)

The deposit model needs the **caller** (the vault) to have a Ref account with enough storage for every token it will hold.

```text
v2.ref-finance.near.storage_deposit({"account_id": null, "registration_only": false})   attach ≥ 0.01 NEAR
v2.ref-finance.near.register_tokens({"token_ids": ["wrap.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "usdt.tether-token.near"]})   attach EXACTLY 1 yocto
```

- `storage_balance_bounds` (live) = `{"min":"1020000000000000000000","max":null}` (0.00102 NEAR).
- Storage math (`account_deposit.rs:20-46,177-183`): base account = 102 bytes (0.00102 NEAR). **Each registered token costs 148 bytes (0.00148 NEAR)**. Three tokens need 0.00102 + 3×0.00148 = **0.00546 NEAR**, so attach 0.01 NEAR.
- `registration_only: true` reserves only the 0.00102 minimum and refunds the rest. It "doesn't leave space for tokens" (`storage_impl.rs:23-36`), so **don't use it for a vault**.
- `register_tokens` / `unregister_tokens`: `assert_one_yocto()` (`account_deposit.rs:322-345`). `unregister` panics if the balance is not 0.
- Check the setup with `storage_balance_of({account_id})`, `get_user_storage_state({account_id})` → `{deposit, usage}`, and `token_register_of({account_id, token_id})` → bool.
- The **vault must also be registered on each token contract** (NEP-145 `storage_deposit` on `wrap.near`, USDC, USDT). If it isn't, every `withdraw` back to the vault fails (see §5).
- Why tokens need registering: `ft_on_transfer` with `msg ""` → `internal_deposit` asserts `is_whitelisted_token(token) || account has token registered` (`ERR12_TOKEN_NOT_WHITELISTED`, `account_deposit.rs:577-592`). wNEAR, USDC (native `17208628…`), USDT (`usdt.tether-token.near`) and USDC.e/USDT.e **are globally whitelisted** (live `get_whitelisted_tokens`, 212 tokens). Register them anyway: `swap` with 0 deposit relies on it (§4), and a token can drop off the whitelist.

## 2. Contract types (exact, `ref-exchange/src/action.rs`)

```rust
pub struct SwapAction {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub amount_in: Option<U128>,   // None ⇒ use previous hop's output; fails on first hop
    pub token_out: AccountId,
    pub min_amount_out: U128,      // REQUIRED, checked on EVERY hop (simple_pool.rs:313 → "E68: slippage error")
}
pub struct SwapByOutputAction { pool_id: u64, token_in, amount_out: Option<U128>, token_out, max_amount_in: Option<U128> }

#[serde(untagged)]
pub enum Action { Swap(SwapAction), SwapByOutput(SwapByOutputAction) }
```

**The untagged-enum trap.** serde tries `Swap` first, then `SwapByOutput`, and unknown fields are ignored. If you forget `min_amount_out`, the JSON fails as `Swap` and gets read as `SwapByOutput` with `amount_out: None`. That only fails because of the "first hop" rule. Always send every `SwapAction` field. **Don't mix the two action types**: `assert_all_same_action_type`, `lib.rs:724`.

`PoolInfo` (returned by `get_pool` / `get_pools`, `views.rs:84-96`):
```json
{"pool_kind":"SIMPLE_POOL","token_account_ids":["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","wrap.near"],
 "amounts":["1182960204925","220634815645565589239836132570"],"total_fee":30,"shares_total_supply":"95651427448564998415993031288","amp":0}
```
(live `get_pool {"pool_id":4512}`, 2026-10-22). `pool_kind` ∈ `SIMPLE_POOL | STABLE_SWAP | RATED_SWAP | DEGEN_SWAP`. `total_fee` is in bps (÷10_000).

## 3. Instant swap (one `ft_transfer_call`, for wallets and frontends)

`token_in.ft_transfer_call({receiver_id: "v2.ref-finance.near", amount, msg})`, attach 1 yocto. `msg` is the untagged `TokenReceiverMessage::Execute` (`token_receiver.rs:20-41`):

```json
{
  "actions": [{"pool_id": 4512, "token_in": "wrap.near", "token_out": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
               "amount_in": "1000000000000000000000000", "min_amount_out": "5300000"}],
  "referral_id": null,
  "skip_unwrap_near": true,
  "swap_out_recipient": null,
  "client_echo": null,
  "skip_degen_price_sync": null,
  "extra_tgas_for_client_echo": null
}
```
- All fields except `actions` are optional. Old docs add `"force":0`; the field is ignored.
- `skip_unwrap_near`: Ref unwraps wNEAR output to native NEAR **only when this is `false`**. The default is "don't unwrap" (`internal_send_tokens`: `is_wnear && !skip_unwrap_near.unwrap_or(true)`, `account_deposit.rs:635`). Set it explicitly.
- `swap_out_recipient`: send the output to another account. It **cannot be combined with `client_echo`** (assert). `client_echo` only works for whitelisted senders (`get_client_echo_sender_id_whitelist`).
- `referral_id`: only takes effect if the referral is registered (`list_referrals`). Unknown referrals are silently ignored (`.and_then(|rid| self.referrals.get(rid))`).
- **Semantics**: the swap runs inside `ft_on_transfer`. A slippage failure panics there, so the token refunds the full input. On success `ft_on_transfer` returns `0` (all used) and sends the output with a **detached** `ft_transfer`. *"Even if send tokens fails, we don't return funds back to sender"* (`token_receiver.rs:157`). A failed output transfer lands in the sender's Ref deposit, or in "lostfound" if the sender isn't registered with Ref. So **the caller's `ft_transfer_call` callback learns only "used = amount_in", never the output amount**. That's why a vault must use the deposit model below.

## 4. Deposit model (deposit → `swap` → `withdraw`): what the vault uses

### 4a. Deposit
`token_in.ft_transfer_call({receiver_id: "v2.ref-finance.near", amount, msg: ""})`, 1 yocto. Empty `msg` = deposit (`token_receiver.rs:118-123`), returns `U128(0)` unused. So the token's `ft_resolve_transfer` gives the vault **used = amount**. Any failure (account not registered `E10`, token not whitelisted/registered `E12`, frozen token, contract paused) panics → **used = 0**, and the tokens come back.

### 4b. `swap(actions, referral_id?, skip_degen_price_sync?) -> U128`
```rust
#[payable]
pub fn swap(&mut self, actions: Vec<SwapAction>, referral_id: Option<ValidAccountId>, skip_degen_price_sync: Option<bool>) -> U128
```
(`lib.rs:349-361`) **Resolves open question #3 (does `swap` need 1 yocto?): no.** `swap` is `#[payable]` but has **no `assert_one_yocto`**. Inside `execute_actions` (`lib.rs:310-345`):
- If `attached_deposit == 0`, every token in every action must be **registered in the caller's Ref account or globally whitelisted**, else panic `ERR27_DEPOSIT_NEEDED`.
- With any deposit > 0 that check is skipped.
- Mainnet shows both: tx `8HTZwvgS…` (deposit 1, OK) and tx `389uyDhd…` (deposit 0, reached pool math and failed only on `E68: slippage error`).
- **Vault rule: register tokens (§1) and attach 0, or attach 1 yocto to be safe.** Either works. The yocto stays with Ref.

Return value: `ActionResult::to_amount()` of the **last** action, i.e. the final hop's `amount_out`, already credited to the caller's Ref deposit (`lib.rs:736-740,778-794`). Each hop's `min_amount_out` is enforced in the pool (`simple_pool.rs:313`), and a failure panics the whole call so the deposits stay unchanged. The output token must fit the caller's storage. Since the output is a new token entry, an unregistered `token_out` with no free storage makes `internal_save_account` panic with `E11: insufficient $NEAR storage deposit`.

Related calls:
- `swap_by_output(actions: Vec<SwapByOutputAction>, …) -> U128` returns the input used.
- `execute_actions_in_va(use_tokens: HashMap<AccountId,U128>, actions, referral_id?, skip_degen_price_sync?) -> HashMap<AccountId,U128>` swaps only the listed deposit amounts in a virtual account and returns every resulting balance (`lib.rs:250-305`).

### 4c. `withdraw(token_id, amount, unregister?, skip_unwrap_near?) -> Promise<U128>`
(`account_deposit.rs:357-383`)
- `assert_one_yocto()`: **exactly 1 yocto**.
- `amount == "0"` means **withdraw the whole balance** of that token. Never pass 0 by accident.
- `unregister: true` also removes the token entry. It panics if any balance is left.
- `skip_unwrap_near` defaults to true here as well (no unwrap) for wNEAR.
- Panics (no state change): `E21` token not registered, `E22` not enough balance, frozen token, contract not Running.
- Flow: subtract from the deposit → `ft_transfer(sender, amount)` (20 Tgas) → `exchange_callback_post_withdraw` (5 Tgas). **Result**: the promise resolves to `U128(amount)` on success. **If the `ft_transfer` fails** (typically: the vault isn't registered on the token), the callback re-credits the amount to the vault's Ref deposit and **resolves to `U128(0)`**. It does not panic.
- If re-crediting fails (not registered with Ref, or no storage), the funds go to user lostfound (`list_lostfound_tokens` / `claim_lostfound`), or to the owner when Ref is low on free NEAR (`internal_handle_fail_in_withdraw_callback`, `account_deposit.rs:466-514`).
- So the vault's callback must handle three outcomes: `Ok(x == amount)` = settled; `Ok(0)` = still in the Ref deposit, retry later; `Err` = `withdraw` panicked, still in the Ref deposit.

### 4d. Views for reconciliation
- `get_deposits({account_id}) -> {token: U128}`
- `get_deposit({account_id, token_id}) -> U128`

A `recover_ref_deposits()` method in the vault should read `get_deposits` and withdraw every non-zero balance.

## 5. Views and quoting

| Method | Args | Returns |
|---|---|---|
| `get_number_of_pools` | `{}` | `u64` (8979 today) |
| `get_pools` | `{"from_index":0,"limit":250}` | `Vec<PoolInfo>` (page it) |
| `get_pool` | `{"pool_id":4512}` | `PoolInfo` |
| `get_pool_by_ids` | `{"pool_ids":[4512,6063]}` | `Vec<PoolInfo>` |
| `get_pool_detail_info` | `{"pool_id":…}` | richer detail |
| `get_return` | `{"pool_id","token_in","amount_in","token_out"}` | `U128` (single pool, fees included, `min_out=0`) |
| `get_return_by_output` | `{"pool_id","token_in","amount_out","token_out"}` | `U128` input needed |
| `predict_swap_actions` | `{"token_deposit":{"wrap.near":"…"},"actions":[SwapAction…]}` | `{token: U128}` final balances (multi-hop simulation) |
| `batch_predict_swap_actions` | `{"batch_token_deposit":[…],"batch_actions":[[…]]}` | `Vec<…>` |
| `get_whitelisted_tokens` / `get_user_whitelisted_tokens{account_id}` | | `Vec<AccountId>` |
| `get_frozenlist_tokens` | `{}` | `[]` today |
| `metadata` | `{}` | `{version, state, pool_count, wnear_id, …}`. Check `state == "Running"` |
| `list_referrals` | `{from_index?, limit?}` | `{account: fee_bps}` |
| `get_degen_return` / `get_rated_return` | pool-kind specific | |

Views like `get_pool` can be called **cross-contract** from the vault (plain function call, no state change).

**Quotes are for UI only, never for min_out.** The vault computes `min_out` from the oracle (vault-spec §8). A pool quote can be manipulated in the same block.

## 6. Which pool? (live, 2026-10-22, block ~220.98M, NEAR ≈ $5.37)

Method: page `get_pools` over all 8979 pools, keep pools whose `token_account_ids` contain both tokens, sort by stable-side reserve, then compare `get_return` at several trade sizes.

| Pair | Pool id | Kind | Fee bps | Reserves | ≈ TVL |
|---|---|---|---|---|---|
| wNEAR/USDC | **4512** | SIMPLE_POOL | 30 | 220,635 wNEAR / 1,182,960 USDC | **$2.37M** |
| wNEAR/USDC | 5515 | DEGEN_SWAP (oracle-assisted) | 30 | 65,257 / 353,984 | $0.70M |
| wNEAR/USDC | 8595 | SIMPLE_POOL | 99 | 3,836 / 20,510 | $41k |
| wNEAR/USDC.e (bridged) | 3 | SIMPLE_POOL | 30 | 9,024 / 48,356 | $97k |
| wNEAR/USDT | **6063** | DEGEN_SWAP | 30 | 42,084 / 228,641 | **$0.45M** |
| wNEAR/USDT | 3879 | SIMPLE_POOL | 30 | 429 / 2,301 | $4.6k (thin) |
| wNEAR/USDT.e | 4 | SIMPLE_POOL | 30 | 17,386 / 93,163 | $186k |
| USDT/USDC | 6416 | DEGEN_SWAP | 1 | 290,646 / 312,617 | $0.60M |
| USDT/USDC/USDT.e/USDC.e | 4179 | RATED_SWAP | 2 | | ~$0.10M |

Quotes (`get_return`, wNEAR → stable, 6-decimal output):

| amount in | 4512 (USDC) | 5515 (USDC) | 6063 (USDT) | 3879 (USDT) |
|---|---|---|---|---|
| 100 wNEAR | 534.49 | 533.75 | 534.10 | 433.65 |
| 1,000 wNEAR | 5,323.2 | 5,335.1 | 5,337.3 | 1,608.6 |
| 10,000 wNEAR | 51,160 | 53,112 | 52,991 | 2,206 |

The research note said "classic pools are thin". **That's wrong for wNEAR/USDC: pool 4512 is the deepest wNEAR/USDC venue on Rhea**, deeper than the DCL pools (see `dcl-pools.md`). Most of the other ~8,970 pools are thin or junk. Many are 0-fee copycat pools holding about $20 (e.g. 7411, 7218, 7359).

**Recommended vault allowlist (demo):**
- `4512` for wNEAR↔USDC.
- For wNEAR↔USDT, `6063` (DEGEN_SWAP) is the only deep pool.

Degen pools re-price from an oracle. `execute_actions` calls `internal_batch_update_degen_token_price` after the swap unless `skip_degen_price_sync: true` (`lib.rs:756-759`), and the pool math uses the stored degen price. **[VERIFY in sandbox/fork: does a stale degen price make the swap panic, and how much gas does the price-sync add?]** Until then the simplest safe choice is USDC-only via 4512. When USDT is needed, add 6063 after testing.

Reproduce (any RPC, e.g. `https://rpc.mainnet.fastnear.com`):
```bash
near view v2.ref-finance.near get_pool '{"pool_id":4512}'
near view v2.ref-finance.near get_return '{"pool_id":4512,"token_in":"wrap.near","amount_in":"1000000000000000000000000000","token_out":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}'
```

## 7. Rust: vault deposit → swap → withdraw chain (near-sdk 5.29.x)

Sketch for vault-spec §6.3. It isn't compiled here **[VERIFY: compile + sandbox test]**. The oracle part is elided; see the oracle/vault skill. Key rules:
- Callbacks never panic (`#[callback_result]`).
- `min_out` comes only from the vault's own oracle math.
- The pool's token pair is verified from `get_pool` before any funds move.

```rust
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue};
use near_sdk::json_types::U128;

const REF_ID: &str = "v2.ref-finance.near";          // hardcoded (feature-flag for sandbox)
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [json])]
#[derive(Clone)]
pub struct RefSwapAction {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub amount_in: Option<U128>,
    pub token_out: AccountId,
    pub min_amount_out: U128,
}

#[near(serializers = [json])]
pub struct RefPoolInfo {
    pub pool_kind: String,
    pub token_account_ids: Vec<AccountId>,
    pub amounts: Vec<U128>,
    pub total_fee: u32,
    pub shares_total_supply: U128,
    pub amp: u64,
}

#[ext_contract(ext_ref)]
pub trait RefExchange {
    fn get_pool(&self, pool_id: u64) -> RefPoolInfo;
    fn swap(&mut self, actions: Vec<RefSwapAction>, referral_id: Option<AccountId>, skip_degen_price_sync: Option<bool>) -> U128;
    fn withdraw(&mut self, token_id: AccountId, amount: U128, unregister: Option<bool>, skip_unwrap_near: Option<bool>) -> U128;
    fn get_deposits(&self, account_id: AccountId) -> std::collections::HashMap<AccountId, U128>;
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> U128;
}

fn ref_id() -> AccountId { REF_ID.parse().unwrap() }

#[near]
impl Vault {
    /// Step 0 (after agent/policy/cap checks + lock): read pool (+ oracle prices, joined with .and()).
    pub fn agent_swap_ref(&mut self, pool_id: u64, token_in: AccountId, token_out: AccountId, amount_in: U128) -> Promise {
        // assert agent, !paused, pool_id ∈ allowed_ref_pools, tokens ∈ allowed_tokens, caps → reserve, in_flight = Started
        ext_ref::ext(ref_id())
            .with_static_gas(Gas::from_tgas(5))
            .get_pool(pool_id)
            // .and(oracle price calls...)
            .then(Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(200))      // must carry the whole rest of the chain
                .on_swap_precheck(pool_id, token_in, token_out, amount_in))
    }

    #[private]
    pub fn on_swap_precheck(&mut self, pool_id: u64, token_in: AccountId, token_out: AccountId, amount_in: U128,
        #[callback_result] pool: Result<RefPoolInfo, PromiseError>) -> PromiseOrValue<()> {
        let Ok(pool) = pool else { return self.fail_op("get_pool failed") };
        // Fake-token / wrong-pool guard: exact 2-token pair, allowed kind.
        let ok_pair = pool.token_account_ids.len() == 2
            && pool.token_account_ids.contains(&token_in)
            && pool.token_account_ids.contains(&token_out)
            && token_in != token_out;
        if !ok_pair || !(pool.pool_kind == "SIMPLE_POOL" /* || allowed degen kind */) {
            return self.fail_op("pool pair/kind mismatch");
        }
        let min_out: u128 = self.compute_min_out_from_oracle(&token_in, &token_out, amount_in.0); // vault-spec §8
        self.set_pending_min_out(min_out);
        // Deposit into Ref: msg "" (empty string = deposit)
        PromiseOrValue::Promise(
            ext_ft::ext(token_in.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(Gas::from_tgas(50))
                .ft_transfer_call(ref_id(), amount_in, None, String::new())
                .then(Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(120))
                    .on_ref_deposited(pool_id, token_in, token_out, amount_in, U128(min_out))))
    }

    #[private]
    pub fn on_ref_deposited(&mut self, pool_id: u64, token_in: AccountId, token_out: AccountId, amount_in: U128, min_out: U128,
        #[callback_result] used: Result<U128, PromiseError>) -> PromiseOrValue<()> {
        match used {
            Ok(u) if u.0 == amount_in.0 => {}
            Ok(u) if u.0 == 0 => return self.fail_op("ref deposit refunded"),   // nothing left the vault
            _ => return self.fail_op_needs_recovery("partial/unknown deposit"), // call recover_ref_deposits
        }
        let action = RefSwapAction { pool_id, token_in: token_in.clone(), amount_in: Some(amount_in),
                                     token_out: token_out.clone(), min_amount_out: min_out };
        PromiseOrValue::Promise(
            ext_ref::ext(ref_id())
                .with_attached_deposit(ONE_YOCTO)            // optional if tokens are registered (§4b)
                .with_static_gas(Gas::from_tgas(25))         // simple pool burns ~4.5 Tgas; degen more [VERIFY]
                .swap(vec![action], None, Some(true))        // skip_degen_price_sync: decide per pool kind [VERIFY]
                .then(Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(60))
                    .on_ref_swapped(token_in, token_out, amount_in, min_out)))
    }

    #[private]
    pub fn on_ref_swapped(&mut self, token_in: AccountId, token_out: AccountId, amount_in: U128, min_out: U128,
        #[callback_result] out: Result<U128, PromiseError>) -> Promise {
        let (tok, amt, swapped) = match out {
            Ok(a) if a.0 >= min_out.0 && a.0 > 0 => (token_out, a, true),   // amount_out is known on-chain here
            _ => (token_in, amount_in, false),                              // swap panicked → input still deposited
        };
        ext_ref::ext(ref_id())
            .with_attached_deposit(ONE_YOCTO)                // withdraw REQUIRES exactly 1 yocto
            .with_static_gas(Gas::from_tgas(35))             // withdraw → ft_transfer(20T) → callback(5T)
            .withdraw(tok.clone(), amt, None, Some(true))
            .then(Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(10))
                .on_ref_withdrawn(tok, amt, swapped))
    }

    #[private]
    pub fn on_ref_withdrawn(&mut self, token: AccountId, expected: U128, swapped: bool,
        #[callback_result] got: Result<U128, PromiseError>) {
        match got {
            Ok(g) if g.0 == expected.0 => { /* emit action_settled{actual_out} (or action_failed if !swapped); unlock */ }
            Ok(_zero) => { /* ft_transfer failed → funds re-credited to vault's Ref deposit; mark NeedsRecovery */ }
            Err(_) => { /* withdraw panicked (frozen/paused) → funds still in Ref deposit; mark NeedsRecovery */ }
        }
    }
}
```

Notes:
- `on_ref_swapped` has the **exact `amount_out`** (the `swap` return value) before anything leaves Ref. That's the whole point of the deposit model.
- Also settle from real balances (vault-spec §7.4): after `on_ref_withdrawn` you can additionally read `token_out.ft_balance_of(vault)`.
- Static-gas numbers are starting points. In near-sdk 5 every call also gets a share of unused gas (default weight 1), so a 300 Tgas tx distributes the leftover. **[VERIFY with sandbox gas profiling]**

### Gas (mainnet observations, 2026-10)
- `swap`, 1 hop, simple pool: **4.54 Tgas burnt** (tx `8HTZwvgSrAt2KG62Q6BrQsRkPBCjZZXYheL3SDSpqBX2`, 50 Tgas attached).
- `withdraw` of wNEAR with unwrap: 3.65 Tgas, plus `near_withdraw` 1.83, plus callback 2.44 Tgas (tx `3gNueTM7…`). The FT path uses `ft_transfer` (20 Tgas reserved) and callback (5 Tgas reserved).
- Ref's internal reservations (`utils.rs`): `GAS_FOR_FT_TRANSFER` 20T, `GAS_FOR_CB_FT_TRANSFER` 5T, `GAS_FOR_NEAR_WITHDRAW` 20T, `GAS_FOR_CB_NEAR_TRANSFER` 10T, `GAS_FOR_FT_TRANSFER_CALL` 30T + `extra_tgas_for_client_echo` (default 15).
- Budget for the whole chain: get_pool + oracle (≈10–15T) → precheck cb → ft_transfer_call (≈40–50T incl. Ref `ft_on_transfer` + resolve) → cb → swap (≈10–25T) → cb → withdraw (≈30–35T) → final cb (≈5–10T). That's **≈150–220 Tgas**, which fits in one 300 Tgas tx. If profiling says otherwise, use the spec's two-tx split (`agent_swap_ref` deposit+swap, then `sync_position` withdraw).

## 8. Common failures (error strings from `errors.rs`, seen on mainnet)
- `E68: slippage error`: min_out not met, whole call reverted.
- `E10: account not registered`: no `storage_deposit` on Ref.
- `E11: insufficient $NEAR storage deposit`: token entry needs storage.
- `E12: token not whitelisted`: deposit of a token that is neither whitelisted nor registered.
- `E21: token not registered`, `E22: not enough tokens in deposit`.
- `E27: attach 1yN to swap tokens not in whitelist`: swap with 0 deposit and unregistered tokens.
- `E28: Illegal msg in ft_transfer_call`: malformed instant-swap msg.
- `E85: invalid pool id` / `E85_NO_POOL`.
- `Requires attached deposit of exactly 1 yoctoNEAR`: `withdraw` / `register_tokens` without 1 yocto.
- Frozen-token panic: a guardian froze the token. Check `get_frozenlist_tokens`.
- Contract not running: check `metadata.state`. After the April 2026 exploit, the Rhea DEX was paused as a precaution.

The E10/E11/E12/E21/E22/E27/E28/E29/E68/E85 strings match both the 1.9.18 copy's `errors.rs` and the strings embedded in the **live 1.9.20 wasm**.

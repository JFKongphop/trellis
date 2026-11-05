# `intents.near`: Verifier contract reference for contract integrators

Source of truth: github.com/near/intents `contracts/defuse` (crate `defuse` 0.4.5). The deployed `intents.near` returns `contract_source_metadata` = `{"version":"0.4.5","link":"…/tree/16d04f6ec4401263f8914638710260da50bb46b0","standards":[dip4 0.1.0, nep245 1.0.0, nep330 1.3.0]}` (queried 2026-10-21). Docs: docs.near-intents.org/integration/verifier-contract/*.

## 1. Authentication model

Every state-changing direct call resolves the acting account with:

```rust
// contracts/defuse/src/contract/accounts/mod.rs
pub fn ensure_auth_predecessor_id(&self) -> AccountId {
    let predecessor_account_id = env::predecessor_account_id();
    if !StateView::is_auth_by_predecessor_id_enabled(self, &predecessor_account_id) {
        DefuseError::AuthByPredecessorIdDisabled(predecessor_account_id).panic();
    }
    predecessor_account_id
}
```

- Auth-by-predecessor is **enabled by default for every account, including accounts that don't exist yet** (`internal_set_auth_by_predecessor_id`: "not-yet-existing accounts have auth by PREDECESSOR_ID enabled by default"). Live check: `is_auth_by_predecessor_id_enabled({"account_id":"some-new-contract.near"})` → `true`.
- So a contract `vault.near` can call `mt_transfer`, `ft_withdraw`, `mt_withdraw` and the rest on its own Intents balance with **no keys**. This is the only auth path our vault uses.
- The second path is **signed intents** (`execute_intents`), verified against public keys registered for the `signer_id`. Implicit accounts (64-hex, or `0x…` for secp256k1) have their own key implicitly. Named accounts must call `add_public_key`.

### `add_public_key` / `remove_public_key`: why a vault must never call them

```rust
#[payable] fn add_public_key(&mut self, public_key: PublicKey);    // assert_one_yocto; account = predecessor
#[payable] fn remove_public_key(&mut self, public_key: PublicKey); // assert_one_yocto
fn has_public_key(&self, account_id: &AccountId, public_key: &PublicKey) -> bool;
fn public_keys_of(&self, account_id: &AccountId) -> HashSet<PublicKey>;
#[payable] fn disable_auth_by_predecessor_id(&mut self);           // "might lock you out of your funds"
fn is_auth_by_predecessor_id_enabled(&self, account_id: &AccountId) -> bool;
fn is_nonce_used(&self, account_id: &AccountId, nonce: AsBase64<Nonce>) -> bool;
```

The docs say: "Each key has full control and can add or remove other keys". A registered key can sign `transfer` or `ft_withdraw` to **any** receiver, `add_public_key` (persisting itself), or `set_auth_by_predecessor_id {enabled:false}`, which locks the contract out. Registering the agent's key would bypass every vault policy. **Rule: no code path in the vault may emit `add_public_key`, `disable_auth_by_predecessor_id`, or `execute_intents`.** Test: `public_keys_of(vault)` returns `[]` and `is_auth_by_predecessor_id_enabled(vault)` returns `true`.

## 2. Deposits: `ft_transfer_call` on the token, `receiver_id = "intents.near"`

```rust
// contracts/defuse/src/contract/tokens/nep141/deposit.rs  (#[pause])
fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
    require!(amount.0 > 0, "zero amount");
    let token_id = TokenId::Nep141(Nep141TokenId::new(env::predecessor_account_id()));
    let DepositMessage { receiver_id, action } = if msg.is_empty() {
        DepositMessage::new(sender_id)                       // credit the sender
    } else {
        msg.parse().unwrap_or_else(|e| panic!("{e}"))         // bad msg => panic => token refunds you
    };
    self.deposit(receiver_id, [(token_id, amount.0)], Some("deposit"))…;
    // optional: execute_intents attached in msg (see below)
    … PromiseOrValue::Value(0.into())                         // always "uses" the full amount
}
```

`msg` forms (`contracts/defuse/src/tokens/mod.rs`, `DepositMessage::from_str`):

| `msg` | Meaning |
|---|---|
| `""` | credit `sender_id` (the caller of `ft_transfer_call`, e.g. the vault) |
| `"bob.near"` (does not start with `{`) | parsed as `AccountId`; credit that account |
| `"{\"receiver_id\":\"bob.near\"}"` | JSON `DepositMessage`, credit `receiver_id` |
| `"{\"receiver_id\":\"bob.near\",\"execute_intents\":[<MultiPayload>…],\"refund_if_fails\":true}"` | credit, then run signed intents. `refund_if_fails: true` runs them synchronously (a panic reverts the deposit). `false` (the default) runs them as a detached promise. |

```rust
pub struct DepositMessage { pub receiver_id: AccountId, #[serde(flatten)] pub action: Option<DepositAction> }
#[serde(untagged)] pub enum DepositAction { Execute(ExecuteIntents) }
pub struct ExecuteIntents { pub execute_intents: Vec<MultiPayload>, #[serde(default)] pub refund_if_fails: bool }
```

- 1 yocto attached to `ft_transfer_call` (NEP-141). Docs use 100 TGas for a plain deposit from a wallet. From a contract, 50–80 TGas total for `ft_transfer_call` is typical. **[VERIFY with sandbox gas profiling]**
- `intents.near` itself needs no storage deposit from you. The **token** must have `intents.near` registered, which it is for listed tokens.
- NEP-171 NFTs use `nft_transfer_call` and NEP-245 tokens use `mt_(batch_)transfer_call`, with the same `msg` rules. Native NEAR is not accepted: wrap to `wrap.near` first.
- The FAQ also shows `msg: "{\"receiver_id\": \"<ACCOUNT_ID>\"}"` for depositing to another account.

## 3. Balances (views)

```rust
fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128;           // token_id "nep141:wrap.near"
fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128>;
fn mt_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u32>) -> Vec<Token>; // NEP-245 enumeration
fn mt_supply(&self, token_id: String) -> Option<U128>;
```

An unparseable `token_id` returns `0` rather than panicking. Token ID formats: `nep141:<ft contract>`, `nep171:<nft contract>:<token id>`, `nep245:<mt contract>:<token id>` (e.g. `nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L`). From a contract, these are cross-contract calls (promise + callback).

## 4. `mt_transfer`: move balance inside Intents

```rust
// contracts/defuse/src/contract/tokens/nep245/core.rs
#[payable] fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128,
                          approval: Option<(AccountId, u64)>, memo: Option<String>);
#[pause(name = "mt_transfer")] #[payable]
fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>,
                     approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>);
// + mt_transfer_call / mt_batch_transfer_call (msg: String) → receiver's mt_on_transfer, with refund resolver
```

- `assert_one_yocto()`. `approvals` must be `None` ("approvals are not supported"). Sender = `ensure_auth_predecessor_id()`.
- These panic with `InvalidIntent` if `sender == receiver`, `amounts` is empty, the lengths differ, or any amount is 0. Other errors: `AccountNotFound` (the sender never had a balance), `AccountLocked`, `BalanceOverflow` (insufficient balance).
- The receiver doesn't need to exist ("get_or_create"). Locked accounts can still **receive**.
- There are no cross-contract calls (pure ledger update plus an `mt_transfer` event). 1 yocto and about 10–30 TGas. **[VERIFY gas]**
- The direct `mt_transfer` path takes **no protocol fee** in the code we read. The 1-pip fee (`fee()` → `1` live) applies to `token_diff` intents. **[VERIFY]**
- **This is how a contract funds a 1Click `INTENTS` quote:** `mt_transfer(receiver_id = quote.depositAddress, token_id = "nep141:<in>", amount = quote.amountIn)`. See one-click-api.md §Funding.

## 5. Withdrawals (direct calls)

```rust
// contracts/defuse/src/tokens/nep141.rs & contract/tokens/nep141/withdraw.rs   (#[pause] #[payable])
fn ft_withdraw(&mut self, token: AccountId /* bare, e.g. "wrap.near" */, receiver_id: AccountId,
               amount: U128, memo: Option<String>, msg: Option<String>) -> PromiseOrValue<U128>;
fn mt_withdraw(&mut self, token: AccountId /* MT contract, e.g. "v2_1.omni.hot.tg" */, receiver_id: AccountId,
               token_ids: Vec<String> /* inner ids, e.g. "137_qiSt…" */, amounts: Vec<U128>,
               memo: Option<String>, msg: Option<String>) -> PromiseOrValue<Vec<U128>>;
fn nft_withdraw(&mut self, token: AccountId, receiver_id: AccountId, token_id: String,
                memo: Option<String>, msg: Option<String>) -> PromiseOrValue<bool>;
// NO direct native_withdraw method: NativeWithdraw exists only as a signed intent.
```

What happens in `ft_withdraw` (from the source):
1. `assert_one_yocto()`. The owner is `ensure_auth_predecessor_id()`.
2. The balance is debited **immediately** (`self.withdraw(...)`).
3. The direct call always builds `FtWithdraw{storage_deposit: None, min_gas: None}`. **There is no storage-deposit option on the direct method.** The receiver must already be registered on `token`.
4. `token.ft_transfer(receiver, amount, memo)` if `msg` is `None`; otherwise `ft_transfer_call(receiver, amount, memo, msg)`. 1 yocto attached. Gas: `min_gas` defaults to 15 TGas for `ft_transfer` and 50 TGas for `ft_transfer_call` (minimum 30), and it also gets the unused gas.
5. `ft_resolve_withdraw` (15 TGas, `#[private]`):
   - `is_call == false`: success → used = amount; failure → used = 0 → **refund** to the owner's Intents balance (memo `REFUND_MEMO`).
   - `is_call == true`: a parsed `U128` → used = min(value, amount). Unparseable → 0 (refund). **A failed promise → used = amount, so NO refund** (the comment cites a NEP-141 gas-griefing issue).
   - It returns `U128(used)`, which is the value your callback sees.

| Call | Transfer used | Refunded if the token call fails? |
|---|---|---|
| `msg: None` / omitted / `null` | `ft_transfer` | Yes |
| `msg: Some("")` or any string | `ft_transfer_call` | No |

The same rule applies to `mt_withdraw` / `nft_withdraw`. The docs recommend leaving `msg` out ("Only omitting msg entirely or setting it to null enables refund protection").

**Signed-intent variants** (`core/src/intents/tokens.rs`) add `storage_deposit: Option<NearToken>`. This is taken from the signer's `nep141:wrap.near` Intents balance, unwrapped via `wrap.near near_withdraw`, then `storage_deposit(receiver)` on the token, and it is **not refunded**. They also add `min_gas: Option<Gas>`. `NativeWithdraw {receiver_id, amount}` unwraps wNEAR and sends NEAR. A contract using predecessor auth can't use these. To get NEAR, `ft_withdraw("wrap.near", vault, amt)` and then call `wrap.near near_withdraw` yourself.

**Withdraw to a foreign chain (POA):** `ft_withdraw(token = "btc.omft.near", receiver_id = "btc.omft.near", amount, memo = "WITHDRAW_TO:<btc address>")`. See bridges-and-tokens.md.

## 6. Rust snippets for a vault (compiled against near-sdk 5.29.1)

```rust
use near_sdk::json_types::U128;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, Promise, PromiseError};

pub const INTENTS: &str = "intents.near";            // hardcode; never take from policy/agent input
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> U128;
}

#[ext_contract(ext_intents)]
pub trait Intents {
    fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128,
                   approval: Option<(AccountId, u64)>, memo: Option<String>);
    fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128;
    fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128>;
    fn ft_withdraw(&mut self, token: AccountId, receiver_id: AccountId, amount: U128,
                   memo: Option<String>, msg: Option<String>) -> U128;
    fn mt_withdraw(&mut self, token: AccountId, receiver_id: AccountId, token_ids: Vec<String>,
                   amounts: Vec<U128>, memo: Option<String>, msg: Option<String>) -> Vec<U128>;
    fn is_auth_by_predecessor_id_enabled(&self, account_id: AccountId) -> bool;
    fn public_keys_of(&self, account_id: AccountId) -> Vec<String>;
    // DELIBERATELY ABSENT: add_public_key, remove_public_key, disable_auth_by_predecessor_id, execute_intents
}

#[near]
impl Vault {
    /// NEP-141 held by the vault -> the vault's own Intents balance (msg "" credits sender_id = vault).
    pub(crate) fn intents_deposit(&mut self, token: AccountId, amount: U128) -> Promise {
        ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(80))                         // [VERIFY]
            .ft_transfer_call(INTENTS.parse().unwrap(), amount, None, String::new())
            .then(Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(10))
                .on_intents_deposit())
    }
    #[private]
    pub fn on_intents_deposit(&mut self, #[callback_result] used: Result<U128, PromiseError>) -> U128 {
        used.unwrap_or(U128(0)) // amount intents.near kept (full amount on success, 0 if refunded)
    }

    /// Fund a verified 1Click INTENTS quote (see one-click-api.md for verification first!).
    pub(crate) fn intents_fund_quote(&mut self, deposit_address: AccountId, token: AccountId, amount: U128) -> Promise {
        ext_intents::ext(INTENTS.parse().unwrap())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(30))                         // [VERIFY]
            .mt_transfer(deposit_address, format!("nep141:{token}"), amount, None, None)
            .then(Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(10))
                .on_mt_transfer())
    }
    #[private]
    pub fn on_mt_transfer(&mut self, #[callback_result] r: Result<(), PromiseError>) -> bool { r.is_ok() }

    /// Intents balance -> vault's NEP-141 balance. NO msg => refundable. Vault must be storage-registered on `token`.
    pub(crate) fn intents_withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        ext_intents::ext(INTENTS.parse().unwrap())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(Gas::from_tgas(60))                         // docs use 100 for a wallet call [VERIFY]
            .ft_withdraw(token, env::current_account_id(), amount, None, None)
            .then(Self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(10))
                .on_intents_withdraw())
    }
    #[private]
    pub fn on_intents_withdraw(&mut self, #[callback_result] r: Result<U128, PromiseError>) -> U128 {
        r.unwrap_or(U128(0)) // delivered amount; any remainder is back in the vault's Intents balance
    }
}
```

Notes:
- Settle from balances (`ft_balance_of(vault)` / `mt_batch_balance_of(vault, …)`) before and after, not from expected values.
- `ft_withdraw` with `receiver_id = vault` emits no `ft_on_transfer` to the vault (it is a plain `ft_transfer`). Account for it from the callback's return value or the balance delta.
- The vault must keep enough NEAR for the 1-yocto deposits and its own storage. Each token needs `storage_deposit(vault)` once (`wrap.near`/USDC bounds: 0.00125 NEAR, live `storage_balance_bounds`).

## 7. Signed intents (`execute_intents`) for completeness

```rust
// contracts/defuse/src/intents.rs
fn execute_intents(&mut self, signed: Vec<MultiPayload>);            // anyone may submit (relayers/solvers)
fn simulate_intents(&self, signed: Vec<MultiPayload>) -> SimulationOutput; // view
// SaltManager
fn current_salt(&self) -> Salt;           // view, live: "252812b3"
fn is_valid_salt(&self, salt: Salt) -> bool;
// FeesManager
fn fee(&self) -> Pips;                    // live: 1  (1 pip = 0.0001%)
fn fee_collector(&self) -> AccountId;     // live: "7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05"
```

- **Atomicity:** ledger changes inside one `execute_intents` call are atomic. Withdrawals and other cross-contract parts are not, and their completion order isn't guaranteed (docs, "Ordering and atomicity").
- **Payload** (`DefusePayload`): `{signer_id, verifying_contract, deadline (ISO-8601), nonce (base64 32 bytes), intents:[…]}`. For NEP-413 the outer object is `{"standard":"nep413","payload":{"recipient":"intents.near","nonce":"<b64>","message":"{\"deadline\":…,\"intents\":[…],\"signer_id\":…}"},"public_key":"ed25519:…","signature":"ed25519:…"}`. `recipient` replaces `verifying_contract`.
- **NEP-413 prehash** (`crates/signatures/nep413`): `sha256(borsh((2147484061u32 /* 2^31+413 */, Nep413Payload{message: String, nonce: [u8;32], recipient: String, callback_url: Option<String>})))`, signed with ed25519.
- Other standards (`MultiPayload`): `erc191`, `tip191` (secp256k1, `v ∈ {0,1}`, public key recovered), `raw_ed25519`, `webauthn` (p256/ed25519), `ton_connect`, `sep53`. Public keys: ed25519 32 B; secp256k1 and p256 **uncompressed 64 B**; signatures raw (not DER).
- **Nonce** (README §Nonces). The legacy form is 32 random bytes; the docs say "will be prohibited". The versioned form is `5628f6c6` (magic) ‖ version byte ‖ salt (4 B, must be a valid salt in the registry) ‖ deadline (u64 **little-endian** ns; the intent deadline must not exceed it) ‖ 15 random bytes. README example: `Vij2xgAlKBKzADZykFdbpB8CcBXsE9wRhklzE4/mgS8=` (version byte `00`). The README text calls this "V1" while the example encodes `00`, so use the byte the current SDK emits. **[VERIFY]**
- Intent kinds (`core/src/intents/mod.rs`): `add_public_key`, `remove_public_key`, `transfer {receiver_id, tokens:{id:amt}, memo?, msg?/min_gas? (notify)}`, `ft_withdraw`, `nft_withdraw`, `mt_withdraw`, `native_withdraw {receiver_id, amount}`, `storage_deposit {contract_id, deposit_for_account_id (alias account_id), amount}`, `token_diff {diff:{id:"±amt"}, memo?, referral?}`, `set_auth_by_predecessor_id {enabled}`, `auth_call`, plus `imt_mint`/`imt_burn` (feature-gated).
- `token_diff` batches must net to zero per token after fees, otherwise the whole batch fails. `simulate_intents` returns `{intents_executed, logs, min_deadline, invariant_violated?, state:{fee, current_salt}}`.

## 8. Admin / governance surface (disclose to users)

From `lib.rs` `Defuse` trait: `AccessControllable` (near-plugins), `Pausable`, `ControllerUpgradable`, `FullAccessKeys`, plus **forced** operations: `ft_force_withdraw`/`mt_force_withdraw`/`nft_force_withdraw` (roles `DAO` or `UnrestrictedWithdrawer`), `mt_force_transfer*`, `force_lock_account`/`force_unlock_account` ("still allows for force withdrawals/transfers"), and `force_disable/enable_auth_by_predecessor_ids`.

Live `intents.near` roles (2026-10-21):

| Role | Grantees |
|---|---|
| super admins | `intents.sputnik-dao.near`, `intents.near` |
| DAO | `intents.sputnik-dao.near` |
| UnrestrictedWithdrawer | none (DAO can still force-withdraw) |
| Upgrader | `ctl-intents.near` |
| PauseManager | 6 implicit accounts + `pm.bridge.near` |
| UnrestrictedAccountLocker | `ac39364a…f538` (implicit) |

The account has no full-access keys, only function-call keys for `intents.near` (relayer keys). In practice: the Intents DAO can pause, upgrade, lock any account, and force-withdraw any balance. Docs/changelog also describe "Proactive Intents Security" / Shield incident handling. A vault's Intents balance is therefore **custodial-risk money**. Keep it transient: pull outputs back with `ft_withdraw` promptly.

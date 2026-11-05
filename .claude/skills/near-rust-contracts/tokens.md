# Fungible tokens from the holder/caller side (NEP-141, NEP-145, wrap.near)

Verified 2026-10-22: `near-contract-standards` 5.29.1 (`fungible_token/{core,core_impl,receiver,resolver}.rs`,
`storage_management/mod.rs`), docs.near.org security/ft-transfer-call, `near/core-contracts` w-near source,
and live mainnet views (`wrap.near`, `usdt.tether-token.near`) via FastNEAR RPC.
Protocol-specific `msg` formats (Burrow, Ref, Intents) are in `rhea-burrow-lending`, `ref-dex-swaps`, `near-intents`.

## 1. NEP-141 methods you call

| Method | Kind | Deposit | Notes |
|---|---|---|---|
| `ft_transfer(receiver_id, amount: U128, memo: Option<String>)` | call | **exactly 1 yocto** | sender = predecessor. Receiver **must be registered** (NEP-145) or it panics |
| `ft_transfer_call(receiver_id, amount, memo, msg: String) -> U128` | call | **exactly 1 yocto** | transfers, calls `receiver.ft_on_transfer`, then `ft_resolve_transfer` refunds unused. Returns the **amount used** |
| `ft_balance_of(account_id) -> U128` | view | – | `"0"` for unknown accounts |
| `ft_total_supply() -> U128` | view | – | |
| `ft_metadata() -> FungibleTokenMetadata` | view | – | `{spec, name, symbol, icon, reference, reference_hash, decimals}` |

Amounts are always `U128` strings in the token's smallest unit (`decimals` from `ft_metadata`: wNEAR 24, USDC/USDT 6).
"1 yocto" means **exactly** `NearToken::from_yoctonear(1)`. More or less makes the token panic.
Function-call access keys can't attach it, so token moves always need a full-access key or a contract.

```rust
use near_contract_standards::fungible_token::core::ext_ft_core;   // or your own #[ext_contract]
use near_contract_standards::fungible_token::metadata::{ext_ft_metadata, FungibleTokenMetadata};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

// Vault → owner (simple transfer; the owner must be registered on `token`)
ext_ft_core::ext(token.clone())
    .with_attached_deposit(ONE_YOCTO)
    .with_static_gas(Gas::from_tgas(10))
    .ft_transfer(self.owner.clone(), amount, None)
    .then(Self::ext_self().with_static_gas(Gas::from_tgas(10)).with_unused_gas_weight(0)
          .on_withdraw_done(token, amount));

// Vault → protocol with a message, and learn how much was really used
ext_ft_core::ext(token)
    .with_attached_deposit(ONE_YOCTO)
    .with_static_gas(Gas::from_tgas(80))            // must cover receiver's ft_on_transfer [VERIFY per protocol]
    .ft_transfer_call(protocol, amount, None, msg)
    .then(Self::ext_self().with_static_gas(Gas::from_tgas(20)).with_unused_gas_weight(0)
          .on_transfer_call_done(op_id));

#[private]
pub fn on_transfer_call_done(&mut self, op_id: u64,
        #[callback_result] used: Result<U128, PromiseError>) {
    let used = used.map(|u| u.0).unwrap_or(0);   // Err ⇒ the whole ft_transfer_call failed ⇒ nothing moved
    // settle: keep reservation for `used`, release (amount - used)
}
```

### Full `ft_transfer_call` sequence (what the vault's callback sees)
1. Token: `assert_one_yocto`, moves `amount` sender→receiver, schedules `receiver.ft_on_transfer(sender_id, amount, msg)`
   (forwards all remaining gas) `.then(self.ft_resolve_transfer(...))` with ~5 Tgas static.
2. Receiver: `ft_on_transfer` returns `unused: U128` (or a promise resolving to it), or panics.
3. Token `ft_resolve_transfer`: `unused = min(returned_or_amount_if_failed, amount)`, refunds
   `min(unused, receiver_balance)` back to the sender, **returns `used = amount - refund`**.
4. Your `.then` callback receives that `used` value.

Consequences:
- If `ft_on_transfer` panics, isn't implemented, or returns garbage → **full refund**, `used = 0`.
- If the receiver isn't registered on the token, or the sender lacks balance → `ft_transfer_call` itself panics.
  Your callback gets `Err(PromiseError::Failed)` and nothing moved.
- The refund is capped by the receiver's balance at resolve time, so a receiver can keep tokens.
  `used` is the amount that actually left you. Trust it, and for protocols also cross-check
  `ft_balance_of(self)` before/after if exact accounting matters.
- `used` measures what left your account, not what the protocol credited you internally.
  Read the protocol's own view for that.

## 2. Being a receiver: `ft_on_transfer`

```rust
#[near]
impl Vault {
    /// Called by a token contract after someone ft_transfer_call'ed us.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String)
        -> PromiseOrValue<U128>
    {
        let token = env::predecessor_account_id();       // the TOKEN contract, not the user
        if !self.tokens.contains_key(&token) {
            return PromiseOrValue::Value(amount);         // unknown token: return everything (refund)
        }
        // optional: parse msg; on a bad msg return `amount` rather than panic (cleaner refund)
        near_sdk::log!("deposit {} of {} from {} ({})", amount.0, token, sender_id, msg);
        PromiseOrValue::Value(U128(0))                    // used everything
    }
}
```
Rules:
- **Authenticate the token by `predecessor_account_id()`** against an allowlist. Anyone can deploy a fake
  token that calls your `ft_on_transfer` with arbitrary `amount`. `sender_id` is just a claimed initiator.
- Return value = **unused** amount: `0` keeps everything, `amount` refunds everything, anything between is a partial refund.
- Don't make `ft_on_transfer` `#[payable]` and don't require deposits. The token calls it with 0 deposit.
- Plain `ft_transfer` into your account (e.g. from a bridge or 1Click) triggers **no callback**. Treat
  `ft_balance_of(vault)` as the source of truth, not an internal counter fed only by `ft_on_transfer`.
- Implementing the trait from near-contract-standards is optional. A plain `pub fn` with this exact
  signature in a `#[near]` impl is enough.

## 3. NEP-145 storage management (registering accounts on a token)

| Method | Deposit | Behavior |
|---|---|---|
| `storage_deposit(account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance` | attach ≥ `min` | registers `account_id` (default predecessor). With `registration_only=true`, excess above `min` is refunded, and the **full** deposit is refunded if already registered |
| `storage_balance_of(account_id) -> Option<StorageBalance>` | view | `null` = not registered. `StorageBalance { total: U128, available: U128 }` |
| `storage_balance_bounds() -> StorageBalanceBounds` | view | `{ min: U128, max: Option<U128> }` |
| `storage_withdraw(amount: Option<NearToken>)` | 1 yocto | |
| `storage_unregister(force: Option<bool>) -> bool` | 1 yocto | panics if balance > 0 unless `force` |

Live values (mainnet, 2026-10-22): `wrap.near`, `usdt.tether-token.near` and native USDC
(`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) all report
`min = max = 1250000000000000000000` yocto (**0.00125 NEAR**). Always read `storage_balance_bounds` rather than hardcoding.

```rust
use near_contract_standards::storage_management::ext_storage_management;
// Register the vault itself on a token (owner-triggered setup)
ext_storage_management::ext(token)
    .with_attached_deposit(NearToken::from_yoctonear(1_250_000_000_000_000_000_000))
    .with_static_gas(Gas::from_tgas(10))
    .storage_deposit(Some(env::current_account_id()), Some(true))
```
- Register **both sides** before any transfer: the vault on every token it will hold, and the **owner** on every
  token the vault may `ft_transfer` back. Otherwise withdrawals fail. A vault can register the owner by
  calling `storage_deposit(Some(owner), Some(true))` and paying for it.
- Protocols (Burrow, Ref, Intents) have **their own** storage deposits for their internal accounts. See their skills.
- Storage deposits cost real NEAR. Track it against a budget (`max_storage_spend` in the vault spec).

## 4. wrap.near (wNEAR), mainnet `wrap.near` / testnet `wrap.testnet`

| Method | Deposit | Behavior |
|---|---|---|
| `near_deposit()` | attach N NEAR (> 0) | mints N wNEAR to predecessor. **Auto-registers** an unregistered caller and deducts `min` storage (0.00125 NEAR) from the minted amount |
| `near_withdraw(amount: U128) -> Promise` | **exactly 1 yocto** | burns wNEAR, sends `amount` NEAR (+ the 1 yocto) back to predecessor |
| `ft_*`, `storage_*` | | standard NEP-141 / NEP-145 |

```rust
#[ext_contract(ext_wrap)]
pub trait WrapNear {
    fn near_deposit(&mut self);
    fn near_withdraw(&mut self, amount: U128);
}

ext_wrap::ext("wrap.near".parse().unwrap())
    .with_attached_deposit(amount)                 // NEAR in
    .with_static_gas(Gas::from_tgas(10))
    .near_deposit()
```
Register on `wrap.near` with `storage_deposit` first, so the full amount is minted and `used` math stays exact.
Keep a NEAR reserve on the vault for storage staking and 1-yocto calls. Don't wrap the whole balance.

## 5. Implicit and other account types (receiving tokens)
- **NEAR-implicit**: 64 lowercase hex chars = hex(ed25519 public key). It always "exists" and becomes
  usable when it receives NEAR via a `Transfer`. It can't be created with `CreateAccount`.
  FT contracts still require `storage_deposit` for it.
- **ETH-implicit**: `0x` + 40 hex. **Deterministic**: `0s` + 40 hex (created by `StateInit`, not Transfer).
- Native USDC on NEAR is an implicit-looking contract id (`17208628…a1`). Treat token ids as opaque `AccountId`s.

## 6. Mistakes to avoid
- Attaching 0 or >1 yocto to `ft_transfer`/`ft_transfer_call`/`near_withdraw`.
- Forgetting the receiver's (or the owner's) NEP-145 registration.
- Trusting `sender_id` or `amount` in `ft_on_transfer` without checking `predecessor_account_id()`.
- Assuming `ft_transfer_call` succeeded because the outer transaction succeeded. Read `used` in a callback.
- Counting deposits only via `ft_on_transfer`: direct `ft_transfer`s bypass it.
- Hardcoding decimals. Read `ft_metadata.decimals` once at registration and store it.
- Using raw `u128` in JSON args. Use `U128`.

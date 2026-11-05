# Events (NEP-297) and the factory pattern (subaccount + global contract + init)

Verified 2026-10-22: NEP-297 text, near-sdk 5.29.1 `#[near(event_json)]` docs and `tests/event_tests.rs`,
docs.near.org anatomy/events + factory tutorial + global-contracts, near-examples/factory-rust (near-sdk 5.29.1),
nomicon account-id rules. The event and factory code below was compiled and unit-tested against near-sdk 5.29.1.

## 1. NEP-297 format
One log line per event:
```
EVENT_JSON:{"standard":"trellis_vault","version":"1.0.0","event":"action_settled","data":[{...}]}
```
- Required: `standard`, `version`, `event` (strings). `data` is optional and any JSON (by convention an **array** of objects).
- Exactly **one event per log entry**, prefixed with `EVENT_JSON:`.
- Limits per receipt: **100 logs, 16 KiB total log bytes** (a panic message counts too). Batch several items into one
  event's `data` array instead of emitting many events.

## 2. Emitting with `#[near(event_json(...))]`
```rust
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

#[near(serializers = [json])]
pub struct SettledData {
    pub op_id: U64,
    pub token: AccountId,
    pub actual: U128,            // U128/U64 → strings. Raw u128 would be a JSON NUMBER (precision loss in JS)
    pub reason_hash: String,
}

#[near(event_json(standard = "trellis_vault"))]
pub enum VaultEvent {
    #[event_version("1.0.0")]
    ActionSettled(Vec<SettledData>),                      // tuple variant → "data": [ {...}, ... ]
    #[event_version("1.0.0")]
    ActionFailed { op_id: U64, reason: String },          // struct variant → "data": { "op_id": "...", ... }
    #[event_version("1.0.0")]
    Paused,                                               // unit variant → no "data" key
}

// in a method:
VaultEvent::ActionSettled(vec![SettledData {
    op_id: U64(op_id), token, actual: U128(used), reason_hash,
}]).emit();
```
Verified output (unit test, near-sdk 5.29.1):
```
EVENT_JSON:{"standard":"trellis_vault","version":"1.0.0","event":"action_settled","data":[{"op_id":"1","token":"usdc.near","actual":"5","reason_hash":"h"}]}
EVENT_JSON:{"standard":"trellis_vault","version":"1.0.0","event":"paused"}
```
- Variant names become `snake_case` event names automatically.
- Each variant needs `#[event_version("x.y.z")]`. Bump it when that event's `data` shape changes.
- Generated helpers: `.emit()`, `.to_json()` (serde_json `Value`), `.to_nep297_event()` (has `.to_event_log()`),
  plus `standard()`, `version()`, `event()` via `AsNep297Event`.
- Emit **after** the state change it describes. In callbacks, emit the settled/failed event as part of settling.
  Logs belong to the receipt outcome. Indexers and the frontend must only trust events from receipts whose status
  is `SuccessValue`/`SuccessReceiptId`, since a failed receipt's state changes were reverted even if its outcome
  shows logs [VERIFY whether failed receipts keep pre-panic logs].
- Manual alternative (no macro): `env::log_str(&format!("EVENT_JSON:{}", serde_json::json!({...})))`.
- Standard token events (`ft_transfer`, `ft_mint`, `ft_burn`, standard `nep141`) are emitted by **token contracts**, not by us.
- Read events from tx outcomes: `receipts_outcome[*].outcome.logs` via RPC `tx` (see `cli.md`), or an indexer.
- In unit tests: `near_sdk::test_utils::get_logs()`.

## 3. Account ID rules (for subaccount naming)
- Total length **2..=64** characters.
- Dot-separated parts. Each part is `[a-z0-9]+` optionally joined by **single** `-` or `_`; no leading/trailing
  separator, no `--`/`__`/`-_`. Regex (without length): `^(([a-z\d]+[\-_])*[a-z\d]+\.)*([a-z\d]+[\-_])*[a-z\d]+$`.
  Lowercase only, so no `@` or uppercase.
- An account can create **only its direct subaccounts**: `trellis.near` can create `x.trellis.near`,
  not `x.alice.near` and not `y.x.trellis.near`.
- Top-level accounts (no dot) of length < 65 can only be created by `registrar`. 64-hex ids are NEAR-implicit
  (created by a `Transfer`), `0x`+40 hex are ETH-implicit, `0s`+40 hex are deterministic (StateInit). None of these
  can be made with `CreateAccount`.
- The parent has **no control** over a subaccount after creation. Only the subaccount's keys/code do.
- Validate in-contract: `"..".parse::<AccountId>()` or `env::is_valid_account_id(bytes)`.

Deriving a vault name from the owner (compiled + tested):
```rust
/// "alice.near" -> "alice-near"; too long or odd → "v" + 20 hex chars of sha256(owner)
pub fn subaccount_name(owner: &AccountId, factory: &AccountId) -> String {
    let base: String = owner.as_str().replace(['.', '_'], "-");
    let max_prefix = 64usize.saturating_sub(factory.as_str().len() + 1);   // "<prefix>.<factory>" ≤ 64
    if !base.is_empty() && base.len() <= max_prefix
        && !base.starts_with('-') && !base.ends_with('-') && !base.contains("--") {
        base
    } else {
        let h = env::sha256_array(owner.as_bytes());
        format!("v{}", h.iter().take(10).map(|b| format!("{:02x}", b)).collect::<String>())
    }
}
```
**Collision warning:** `alice.bob.near` and `alice-bob.near` both map to `alice-bob-near`. `CreateAccount` on an existing
account fails, the whole batch reverts and the deposit is refunded (handled by the callback below). Either accept
"first come first served" and let the owner pass an explicit name, or always use the hash form.

## 4. Factory: create + fund + deploy (global) + init in ONE batch
All actions in one `Promise` to the same receiver are **one receipt and atomic**: if `new` panics, the account
creation, transfer and code reference are all reverted, and the NEAR returns to the **factory** (the receipt's
predecessor). The callback must refund the user.

```rust
use near_sdk::json_types::Base58CryptoHash;
use near_sdk::serde_json::json;
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

const MIN_VAULT_DEPOSIT: NearToken = NearToken::from_near(1);
const GAS_INIT: Gas = Gas::from_tgas(30);          // [VERIFY] measure `new` in sandbox
const GAS_CREATE_CB: Gas = Gas::from_tgas(15);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    vault_code_hash: Base58CryptoHash,             // global contract deployed BY HASH (immutable)
    admin: AccountId,
}

#[near]
impl Factory {
    #[init]
    pub fn new(vault_code_hash: Base58CryptoHash, admin: AccountId) -> Self { Self { vault_code_hash, admin } }

    #[payable]
    pub fn create_vault(&mut self) -> Promise {
        let owner = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_VAULT_DEPOSIT, "Attach at least 1 NEAR");
        let factory = env::current_account_id();
        let vault_id: AccountId = format!("{}.{}", subaccount_name(&owner, &factory), factory)
            .parse().unwrap_or_else(|_| env::panic_str("invalid vault account id"));

        let init_args = json!({ "owner": owner }).to_string().into_bytes();
        Promise::new(vault_id.clone())
            .create_account()                                  // CreateAccount
            .transfer(deposit)                                 // Transfer (covers storage + reserve)
            .use_global_contract(self.vault_code_hash)         // UseGlobalContract (by hash)
            // .deploy_contract(VAULT_WASM.to_vec())           // alternative: DeployContract with embedded wasm
            .function_call("new".to_string(), init_args, NearToken::from_yoctonear(0), GAS_INIT)  // FunctionCall
            // NOTE: no add_full_access_key → the vault is a locked account controlled only by its code
            .then(
                Self::ext(factory)
                    .with_static_gas(GAS_CREATE_CB)
                    .with_unused_gas_weight(0)
                    .on_vault_created(vault_id, owner, deposit),
            )
    }

    #[private]
    pub fn on_vault_created(
        &mut self,
        vault_id: AccountId,
        owner: AccountId,
        deposit: NearToken,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> Option<AccountId> {
        match result {
            Ok(()) => Some(vault_id),
            Err(_) => {
                log!("vault creation failed; refunding {}", deposit);
                Promise::new(owner).transfer(deposit).detach();   // batch reverted → NEAR is back on the factory
                None
            }
        }
    }
}
```
Notes:
- The batch's `.then` result is the result of the **last** action (`new`). `new` returns nothing, hence `Result<(), _>`.
- Deposit sizing: the vault needs NEAR for its own state (receipts, maps), protocol storage deposits (Burrow ≥ 0.1 NEAR,
  FT registrations at 0.00125 each) and the `min_near_reserve`. With a global contract, code storage is ~0.
  The first 770 bytes are free, but anything larger is fully staked. 1 NEAR is a reasonable starting minimum.
- The init method can't receive a deposit inside this batch (the `function_call` attaches 0). The `Transfer` before it
  already funded the account.
- The factory gets **no rights** over the vault: no keys added, owner = caller. Make sure `new` doesn't record the
  factory as privileged.
- The `use_global_contract` hash must already be deployed globally (CLI `deploy-as-global ... as-global-hash`, see
  `cli.md`). Get the hash as base58 of `sha256(wasm)`. `cargo near build` prints the sha256 [VERIFY format], or compute it
  with `sha256sum` and base58-encode it.
- Fallback without global contracts: embed the wasm (`include_bytes!`) and use `.deploy_contract(code)`. Then each vault
  stakes ~1 NEAR per 100 kB of wasm, and the factory build needs a `build.rs` using `cargo_near_build::extended`
  (see the near-sdk `examples/factory-contract/high-level`).
- `use_global_contract_by_account_id(deployer)` would make every vault follow the deployer's latest code, i.e. we could
  upgrade all vaults. That's a trust trade-off. See `security.md` §9.
- Gas: the whole `create_vault` tx fits easily in the 1 PGas limit. Attach ~100 Tgas from the frontend [VERIFY].
- Listing vaults: the factory can store `owner → vault_id` in a `LookupMap` (charge the storage to the caller) so the
  frontend can find a user's vault with one view call.

# NEAR Rust contract basics (near-sdk 5.29.1, cargo-near 0.22.0)

Verified 2026-10-22 against the `near-sdk-v5.29.1` tag of near-sdk-rs, crates.io, and docs.near.org.
All code in this file was compiled and unit-tested against `near-sdk = "=5.29.1"`.

## 1. Toolchain and project setup

| Tool | Version (crates.io, 2026-10-22) | Notes |
|---|---|---|
| near-sdk | **5.29.1** (5.30.0-rc.1 exists on master, not stable) | MSRV 1.93, edition 2024 |
| near-contract-standards | 5.29.1 | NEP-141/145/171 helpers + `ext_*` traits |
| cargo-near | **0.22.0** | build / deploy / new / abi / check |
| near-cli-rs (`near`) | 0.30.1 | see `cli.md` |
| near-workspaces | 0.23.0 | testing: see skill `near-contract-testing` |

Install:
```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
# or: cargo install --locked cargo-near
rustup target add wasm32-unknown-unknown
```

New project and the build/deploy loop:
```bash
cargo near new trellis-vault                 # scaffold (needs git); edition 2024, rust 1.93 toolchain
cd trellis-vault
cargo near check                            # fast type-check in the exact build env (+ --clippy)
cargo near build non-reproducible-wasm      # dev build → target/near/<crate_name>.wasm
cargo near build reproducible-wasm          # Docker, needs committed Cargo.lock + clean git tree
cargo near deploy build-non-reproducible-wasm <account.testnet> \
  with-init-call new json-args '{"owner":"alice.testnet"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
# no init: replace `with-init-call ... attached-deposit '0 NEAR'` with `without-init-call`
```

**Always build with `cargo near`.** Since near-sdk 5.27, the SDK picks its on-chain host-function
path from `--cfg near`, which cargo-near force-appends. A plain `cargo build --target wasm32-unknown-unknown`
doesn't set it. cargo-near also strips ambient `RUSTFLAGS`, so use `--env 'RUSTFLAGS=...'` if you need custom flags.

`Cargo.toml` essentials (from the `cargo near new` template):
```toml
[package]
edition = "2024"
rust-version = "1.93"
repository = "https://github.com/<org>/<repo>"   # used by reproducible build + NEP-330 metadata

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
near-sdk = "5.29"
near-contract-standards = "5.29"   # optional

[dev-dependencies]
near-sdk = { version = "5.29", features = ["unit-testing"] }

[profile.release]
codegen-units = 1
opt-level = "z"
lto = true
debug = false
panic = "abort"
overflow-checks = true          # NEVER remove — arithmetic overflow panics instead of wrapping

[lints.rust.unexpected_cfgs]
level = "warn"
check-cfg = ['cfg(near)']

[package.metadata.near.reproducible_build]
image = "sourcescan/cargo-near:0.22.0-rust-1.97.1"
image_digest = "sha256:7467038bdddc86484b73b416eeadce926ff59013e128e53dec5a19e1cb4b2234"
passed_env = []
container_build_command = ["cargo", "near", "build", "non-reproducible-wasm", "--locked"]
```
Feature flags on near-sdk: `unit-testing` (dev only), `unstable` (enables `store::TreeMap`),
`legacy` (old `near_sdk::collections`), `abi`, `deterministic-account-ids` (`Promise::refund_to`, `state_init`).
`global-contracts` is now a no-op: global contract APIs are always on since 5.25.

## 2. Contract skeleton

```rust
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

#[derive(BorshStorageKey)]
#[near]                                   // = borsh serializer
enum StorageKey {
    Tokens,
    Spent,
    Receipts,
    PerUser { account_hash: Vec<u8> },    // nested collections: derive a unique prefix per parent
}

#[near(serializers = [borsh, json])]      // borsh for state, json for args/returns
#[derive(Clone)]
pub struct TokenInfo {
    pub decimals: u8,
    pub daily_cap: U128,                  // JSON-facing u128 → U128 (string on the wire)
}

#[near(contract_state)]                   // exactly one per crate; stored under key "STATE"
#[derive(PanicOnDefault)]                 // forces explicit #[init]; no silent Default state
pub struct Vault {
    owner: AccountId,
    agent: Option<AccountId>,
    paused: bool,
    tokens: IterableMap<AccountId, TokenInfo>,
    spent: LookupMap<(AccountId, u64), u128>,
    receipts: Vector<String>,
}

#[near]                                   // exports every `pub fn` as a contract method
impl Vault {
    #[init]                               // panics "The contract has already been initialized" on re-run
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            agent: None,
            paused: false,
            tokens: IterableMap::new(StorageKey::Tokens),
            spent: LookupMap::new(StorageKey::Spent),
            receipts: Vector::new(StorageKey::Receipts),
        }
    }

    pub fn get_owner(&self) -> &AccountId { &self.owner }       // &self → view method

    #[payable]                            // without it, any attached deposit panics
    pub fn set_agent(&mut self, agent: Option<AccountId>) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        self.agent = agent;
    }

    #[private]                            // only callable when predecessor == current_account_id
    pub fn on_something(&mut self) {}
}
```

Macro facts (from near-sdk docs):
- `#[near(contract_state)]` also generates `VaultExt` and the `Vault::ext(account)`,
  `Vault::ext_self()` and `Vault::ext_on(promise)` builders for cross-contract calls.
- `#[near(contract_state(key = b"CUSTOM"))]` changes the root state key.
- `#[init(ignore_state)]` skips the "already initialized" check (used by `migrate`, see `security.md`).
- `#[private]` can be combined with `#[init]` (since 5.18).
- `#[handle_result]` lets a method return `Result<T, E>` (`E: FunctionError` or `&str`) and panics on `Err`.
- `#[deny_unknown_arguments]` rejects JSON args with unknown fields.
- `#[near(serializers=[json])]` applies `#[serde_as]`, so `#[serde_as(as = "DisplayFromStr")] amount: u128` works.
- `near_bindgen` is the old name. Use `#[near]` / `#[near(contract_state)]` in new code.
- A `pub fn` inside `#[near] impl` is a public contract method. Put helpers in a separate non-`#[near]` impl block or make them private (no `pub`).

## 3. Collections (`near_sdk::store`)

| Type | Use | Notes |
|---|---|---|
| `LookupMap<K,V>` | key→value, no iteration | cheapest; `get`, `get_mut`, `insert`, `remove`, `contains_key`, `entry` |
| `IterableMap<K,V>` | iterable map | replaces deprecated `UnorderedMap`; `remove` swaps last element in (O(1), costs extra writes) |
| `IterableSet<T>` / `LookupSet<T>` | sets | `UnorderedSet` is deprecated |
| `Vector<T>` | growable array | `push`, `get(idx)`, `swap_remove`, `len() -> u32` |
| `LazyOption<T>` / `Lazy<T>` | big single value loaded on demand | |
| `TreeMap<K,V>` | ordered map | needs `features = ["unstable"]` |

Rules:
- **Every collection needs a unique prefix.** Two collections sharing a prefix silently corrupt each other.
  Use a `BorshStorageKey` enum; for collections inside per-user structs derive the prefix from the
  user (e.g. `StorageKey::PerUser { account_hash: env::sha256(id.as_bytes()) }`).
- `store` collections cache writes and **flush on `Drop`** (end of the method) or explicit `.flush()`.
  `get` returns `Option<&V>`; clone/copy out (`.copied()`, `.cloned()`) before mutating `self`.
- Don't put an unbounded `Vec`/`HashMap` directly in the state struct: the whole struct is (de)serialized
  on every call. Small bounded `Vec`s (like the policy allowlists) are fine.
- Views over collections must paginate (`from_index`, `limit`). Gas is limited even for views.
- `near_sdk::collections::*` is the legacy module (behind `legacy` feature for some types). Don't mix it into new code.

```rust
// Copy out first, then mutate: avoids holding a borrow of self.spent
let key = (token.clone(), env::block_timestamp() / 86_400_000_000_000);
let spent = self.spent.get(&key).copied().unwrap_or(0);
let new_spent = spent.checked_add(amount.0).unwrap_or_else(|| env::panic_str("overflow"));
self.spent.insert(key, new_spent);

// Paginated view
pub fn get_tokens(&self, from_index: u32, limit: u32) -> Vec<(AccountId, TokenInfo)> {
    self.tokens.iter().skip(from_index as usize).take(limit as usize)
        .map(|(k, v)| (k.clone(), v.clone())).collect()
}
```

## 4. Types

| Type | Meaning | JSON form |
|---|---|---|
| `AccountId` | validated account id (`"alice.near".parse::<AccountId>()`) | string |
| `NearToken` | yoctoNEAR amount: `from_near(1)`, `from_millinear(5)`, `from_yoctonear(1)`, `.as_yoctonear()`, `saturating_*`/`checked_*` | string of yocto |
| `Gas` | `Gas::from_tgas(30)`, `from_gas(n)`, `.as_tgas()`, `saturating_sub` | string of gas units (`"30000000000000"`) |
| `U128`, `U64`, `I128`, `I64` (`json_types`) | wrappers that serialize as **strings** | `"123"` |
| `Base64VecU8`, `Base58CryptoHash` | binary args | string |
| `PublicKey` | `"ed25519:…"` / `"secp256k1:…"` | string |
| `PromiseOrValue<T>` | return either an immediate value or a promise | |

- **Never put raw `u128`/`u64` in JSON args or returns.** JS loses precision above 2^53.
  `near_sdk::json_types::U128` / `U64` (or `NearToken`, which serializes as a string) fix that.
  This includes NEP-297 event payloads: a raw `u128` field serializes as a JSON **number** (verified).
- 1 NEAR = 10^24 yoctoNEAR. Storage costs 10^19 yocto per byte (1 NEAR per 100 kB).

## 5. Environment (`near_sdk::env`)

| Function | Returns |
|---|---|
| `predecessor_account_id()` | immediate caller (account or contract). **Use this for auth.** |
| `signer_account_id()` / `signer_account_pk()` | original transaction signer and the key it used (rarely right for auth) |
| `current_account_id()` | this contract |
| `attached_deposit()` | `NearToken` attached to this call |
| `block_timestamp()` / `block_timestamp_ms()` | ns / ms since epoch (u64) |
| `block_height()`, `epoch_height()`, `chain_id()` (5.29+) | |
| `account_balance()`, `account_locked_balance()` | `NearToken` (balance includes the attached deposit) |
| `storage_usage()`, `storage_byte_cost()` | bytes used; 10^19 yocto |
| `prepaid_gas()`, `used_gas()` | `Gas` |
| `sha256(bytes) -> Vec<u8>`, `sha256_array(bytes) -> [u8;32]`, `keccak256_array` | hashes |
| `ed25519_verify(&[u8;64], msg, &[u8;32]) -> bool` | signature check (also `ecrecover`, `p256_verify` 5.29+) |
| `random_seed_array()` | block-producer influenced. Not for value-bearing randomness. |
| `is_valid_account_id(&[u8])` | |
| `current_contract_code()` | `AccountContract::{None, Local(hash), Global(hash), GlobalByAccount(id)}` |
| `promise_results_count()`, `promise_result_checked(idx, max_len)` | low-level callback results. `promise_result` is **deprecated**. |
| `panic_str(&str) -> !`, `abort()` | abort the receipt (all its state changes revert) |
| `log_str(&str)` | log line (max 100 logs / 16 KiB per receipt) |

```rust
let sig: [u8; 64] = sig.try_into().unwrap_or_else(|_| env::panic_str("bad sig len"));
let pk: [u8; 32] = pk.try_into().unwrap_or_else(|_| env::panic_str("bad pk len"));
let digest: [u8; 32] = env::sha256_array(quote_json.as_bytes());
let ok = env::ed25519_verify(&sig, digest, &pk);  // or the raw message, depending on what was signed [VERIFY per signer]
```

Logging: `near_sdk::log!("deposit {} from {}", amount.0, sender)` (format-style, wraps `env::log_str`).
`require!(cond, "msg")` panics with a message and is cheaper than `assert!`.

## 6. Unit-test context (quick reference; full testing → `near-contract-testing`)
```rust
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::testing_env;
let mut ctx = VMContextBuilder::new();
ctx.predecessor_account_id(accounts(0)).attached_deposit(NearToken::from_yoctonear(1));
testing_env!(ctx.build());
```
Promises aren't executed in unit tests. Return values that are `Promise` must be `.detach()`ed or bound to a variable.

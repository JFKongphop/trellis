# Trellis Policy Vault: contract spec (draft v0.1)

Status: draft, 2026-10-22. Based on `docs/research.md`.
Items marked **[VERIFY]** depend on facts we still need to confirm with a small mainnet test or by reading deployed code.

---

## 1. Purpose

A per-user NEAR smart contract that holds the user's funds and lets an AI agent manage them **only within rules the user set**. The rules are enforced by the contract, not by our server. If the agent, its key, or our backend is compromised, the worst case is bounded by the policy.

### Goals
1. Agent can run a leveraged lending strategy on Rhea (Burrow) and swap on Ref without the user signing each step.
2. Agent can route funds through NEAR Intents (swaps, cross-chain yield) under the same rules.
3. Funds can only ever leave the vault to: allowlisted protocol contracts (for strategy actions) or the owner.
4. Every agent action produces an on-chain receipt event.
5. Owner can pause, revoke the agent, change rules, and withdraw everything at any time, even while an operation is stuck.

### Non-goals (hackathon)
- Multiple owners / DAO ownership.
- Margin trading on Burrow (disabled on mainnet after the April 2026 exploit).
- Concentrated-liquidity (dclv2) swaps inside the vault (interface unverified; stretch).
- Rhea's aggregator (`aggregatedex.near`) inside the vault: its route is an opaque server-signed blob the vault can't check.

---

## 2. Accounts and roles

| Account | Example | Role |
|---|---|---|
| Factory | `trellis.near` | Creates vaults. Has **no** rights over vaults after creation. |
| Vault | `alice-near.trellis.near` | One per user. Holds funds, owns the Burrow position, owns the Intents balance. |
| Owner | `alice.near` | The user. Full control via their wallet. |
| Agent | `agent.trellis.near` | Our agent account. Calls `agent_*` methods. Shared across vaults. |

### Agent keys (defense in depth)
- The agent account holds **one function-call access key per vault**: `receiver_id = <vault>`, `method_names = [agent_* methods + sync_position]`, gas allowance capped.
- The agent account's full-access key is kept offline; the worker only has the function-call keys.
- The vault additionally checks `predecessor_account_id == policy.agent` on every agent method.
- So: a stolen worker key can only call `agent_*` on vaults, and the vault's policy limits what those calls can do.
- Consider NEP-611 gas keys for parallel agent transactions (stretch).

### Why not put the agent key on the vault account
On the vault account itself, agent-signed calls and real callbacks both have `predecessor == current_account_id`, which weakens `#[private]` callbacks. A separate agent account keeps the checks clean.

---

## 3. Deployment

- The vault code is deployed once as a **global contract** (NEP-591, supported in near-sdk ≥ 5.25 without feature flags; publishing costs 10 NEAR per 100 kB, burned). Each vault references it **by code hash, not by account id**: referencing by account would let the deployer upgrade every user's vault.
- `factory.create_vault()` (payable, ≥ `MIN_VAULT_DEPOSIT`, suggest 1 NEAR):
  1. Derives the subaccount name as a hash of the caller's account id (e.g. first 16 hex chars of sha256). A readable `alice-near` name is unsafe: `alice.bob.near` and `alice-bob.near` would collide.
  2. `CreateAccount` + `Transfer` + `UseGlobalContract` + `FunctionCall new(owner = caller)`.
  3. Adds **no** access keys to the vault. The vault is controlled only through its own methods.
- Upgrades: only the owner can call `upgrade(code_hash)` (switches to a newer global contract version) followed by `migrate()`. The factory can't upgrade vaults.

---

## 4. State

```rust
#[near(contract_state)]
pub struct Vault {
    owner: AccountId,
    policy: Policy,
    paused: bool,

    /// Per-token metadata needed for checks (set by owner via register_token).
    tokens: IterableMap<AccountId, TokenInfo>,

    /// Spending reserved/used per (token, day index). day = block_timestamp / 86_400e9.
    spent: LookupMap<(AccountId, u64), u128>,

    /// Single in-flight operation lock (see §7).
    in_flight: Option<PendingOp>,
    next_op_id: u64,

    /// Last N receipts kept in state for an indexer-free feed (ring buffer, N = 50).
    receipts: Vector<ReceiptView>,
    receipts_head: u32,
}

#[near(serializers = [borsh, json])]
pub struct TokenInfo {
    decimals: u8,               // from ft_metadata
    burrow_extra_decimals: u8,  // Burrow inner decimals (USDC/USDT = 12, wNEAR = 0)
    price_id: String,           // aggregate-oracle.near price identifier (from Burrow get_all_token_pyth_infos)
    volatility_ratio_bps: u32,  // Burrow collateral factor, e.g. wNEAR 7500
    storage_registered: bool,   // vault registered on this FT
}

#[near(serializers = [borsh, json])]
pub struct Policy {
    agent: Option<AccountId>,
    agent_expires_at: Option<u64>,          // ns timestamp; None = no expiry

    allowed_tokens: Vec<AccountId>,         // every token in/out of any action must be here
    allowed_ref_pools: Vec<u64>,            // Ref v2 pool ids the agent may swap through

    per_action_cap: Vec<(AccountId, U128)>, // max amount of a token sent out in one action
    daily_cap: Vec<(AccountId, U128)>,      // max amount of a token sent out per UTC day

    max_slippage_bps: u16,                  // vs oracle price, e.g. 100 = 1%
    min_health_factor_bps: u32,             // agent may never push HF below this, e.g. 15000 = 1.5
    emergency_floor_bps: u32,               // HF floor allowed during deleverage steps, e.g. 11000
    max_price_age_sec: u32,                 // oracle freshness, e.g. 90
    max_price_conf_bps: u16,                // reject prices whose conf/price is wider than this

    burrow_enabled: bool,
    ref_enabled: bool,
    intents_enabled: bool,
    intents_quote_pubkey: Option<String>,   // 1Click quote-signing key; agent Intents routing is OFF if None

    min_near_reserve: NearToken,            // vault never spends NEAR below this (storage, 1 yocto calls)
    max_storage_spend: NearToken,           // total NEAR the vault may spend on storage deposits
}
```

Hardcoded (not in policy, so a bad policy can't redirect them):
`BURROW = contract.main.burrow.near`, `REF = v2.ref-finance.near`, `ORACLE = aggregate-oracle.near`, `INTENTS = intents.near`, `WRAP = wrap.near`. Testnet/sandbox builds use a feature flag for different ids.

---

## 5. Methods

### 5.1 Owner methods
All: `predecessor == owner` **and** `assert_one_yocto()` (forces a full-access-key / wallet-confirmed signature; the agent can never call these). All work while paused and while an operation is in flight unless noted.

| Method | Effect |
|---|---|
| `set_policy(policy)` | Replace the policy. Validates: caps non-zero, `min_health_factor_bps ≥ 11000`, `emergency_floor_bps ≥ 10500`, slippage ≤ 500 bps, every capped token is allowed. Emits `policy_changed`. |
| `set_agent(agent, expires_at)` | Set/replace the agent. Emits `agent_set`. |
| `revoke_agent()` | `policy.agent = None`. Emits `agent_revoked`. Instant; no key handling needed. |
| `pause()` / `unpause()` | Agent methods fail while paused. |
| `register_token(token)` | Calls `ft_metadata`, `storage_deposit` on the token, and reads Burrow `get_asset` + `get_all_token_pyth_infos` to fill `TokenInfo`. Spends from vault NEAR within `max_storage_spend`. |
| `setup_protocols()` | One-time: `storage_deposit` on Burrow (≥ 0.1 NEAR) and Ref; registers tokens on Ref. |
| `withdraw_near(amount)` | Transfers NEAR **to owner only**. |
| `withdraw_ft(token, amount)` | `ft_transfer` **to owner only**. No dependency on Burrow/Ref/Intents, so it works if those are down. |
| `owner_burrow(actions)` | Owner-signed passthrough to Burrow `execute_with_pyth` (e.g. close the position manually). Owner may do anything; policy applies to the agent only. |
| `owner_intents_withdraw(token, amount)` | Pull the vault's Intents balance back to the vault. |
| `clear_stale_lock(op_id)` | Clears `in_flight` if older than `STALE_LOCK_SECS` (e.g. 15 min). Releases its cap reservation only if the op never left the vault (state `Started`). |
| `upgrade(code_hash)` + `migrate()` | See §3. |

### 5.2 Deposits (anyone)
- `ft_on_transfer(sender_id, amount, msg)`: accept (return `0`) only if `predecessor` (the token) is in `tokens`; otherwise return `amount` (refund). Emits `deposit`.
- Plain `ft_transfer` deposits (e.g. from 1Click) arrive with no callback; balances are always read from the token contract (`ft_balance_of`), never from an internal counter.
- NEAR: plain transfers to the vault account are allowed.

### 5.3 Agent methods
Common checks (in this order) for every `agent_*` method:
1. `predecessor == policy.agent` and `agent_expires_at` not passed.
2. `!paused`.
3. No deposit attached (non-payable).
4. `in_flight.is_none()` (except `sync_position`).
5. Feature flag on (`burrow_enabled` / `ref_enabled` / `intents_enabled`).
6. All tokens involved are in `allowed_tokens`.
7. For outflows: `amount ≤ per_action_cap[token]` and `spent[(token, today)] + amount ≤ daily_cap[token]` → **reserve** the amount now (optimistic).
8. Vault NEAR balance stays ≥ `min_near_reserve` after any attached 1 yocto / storage.
9. Every method takes `reason_hash: String` (sha256 of the agent's reasoning log entry), copied into events.

| Method | Outflow? | HF check | Notes |
|---|---|---|---|
| `agent_wrap_near(amount)` | NEAR → wNEAR | — | `wrap.near near_deposit` with attached NEAR. Counts against the wNEAR cap. |
| `agent_supply(token, amount)` | Yes (to Burrow) | — | Supply as collateral. |
| `agent_borrow(token, amount)` | No | **Pre-check** projected HF ≥ `min_health_factor_bps` | Borrow + withdraw to vault. Result reconciled later. |
| `agent_repay(token, amount)` | No cap (improves HF) | — | Bounded by actual debt. |
| `agent_withdraw_collateral(token, amount)` | No | **Pre-check** projected HF ≥ min (or ≥ `emergency_floor_bps` when `deleverage = true` and debt > 0) | Brings collateral back to the vault. |
| `agent_swap_ref(pool_id, token_in, token_out, amount_in)` | Yes (to Ref) | — | Vault computes `min_out` from oracle; see §6.3. |
| `agent_route_intents(quote_json, signature)` | Yes (to Intents) | — | Only if `intents_quote_pubkey` set; see §6.4. |
| `agent_intents_withdraw(token, amount)` | No | — | Pulls vault's Intents balance back into the vault. |
| `sync_position()` | No | Reads HF | Finalizes a `Submitted` op; also callable by owner. Allowed while paused. |

`deleverage` is a flag on `agent_withdraw_collateral`, not a separate method. The deleverage sequence is: withdraw collateral (HF may dip to the emergency floor) → swap to the debt token → repay. Each step is its own agent transaction.

### 5.4 Views
`get_policy()`, `get_status() -> {owner, paused, agent, in_flight, today_spent[], near_balance}`, `remaining_daily(token)`, `get_tokens()`, `get_receipts(from, limit)`, `health_factor_cached()` (last value computed by a check/sync, with timestamp).

---

## 6. Flows

### 6.1 Supply
```
agent_supply(token, amount)
  checks + reserve → in_flight = {Supply, Started}
  token.ft_transfer_call(BURROW, amount, msg = "\"OnlyIncreaseCollateral\"")
      (the msg is a JSON string, quotes included. Don't use {"Execute":{IncreaseCollateral}} without
       max_amount: it collateralizes ALL supplied balance of that token. Never use ExecuteWithPyth inside
       ft_transfer_call: if its actions fail, the deposit stays as plain supplied and is not refunded.)
  Repay uses msg = "\"OnlyRepay\"" (overpayment lands as plain supplied → needs a Withdraw; repaying
  with no debt panics → refunded).
  .then(on_supply_done(op_id))
on_supply_done: #[callback_result] U128 used
  used == 0 or Err  → release reservation for (amount - used), emit action_failed
  else              → keep reservation for `used`, emit action_settled{actual_in: used}
  in_flight = None
```

### 6.2 Borrow (and withdraw collateral)
Burrow's `execute_with_pyth` doesn't return its inner promise, so the vault can't see whether the borrow succeeded. We pre-check, submit, then reconcile.
```
agent_borrow(token, amount)
  checks → in_flight = {Borrow, Started}
  join( BURROW.get_account_all_positions(vault),
        ORACLE.get_price_no_older_than(price_id, max_price_age) for each token in position ∪ {token} )
  .then(on_borrow_precheck(op_id))
on_borrow_precheck:
  any view failed / price missing / stale / conf too wide → fail (emit action_failed{reason}), unlock
  projected_hf = HF(position with debt[token] += amount)       (§8)
  projected_hf < min_health_factor_bps → fail (emit policy_violation), unlock
  else BURROW.execute_with_pyth({"actions":[{"Borrow":{"token_id","amount"}},{"Withdraw":{"token_id","max_amount"}}]})
       (max_amount, never exact amount: Burrow may credit 1 inner unit short and an exact Withdraw then fails)
       attach 1 yocto, gas ~250 Tgas                                [VERIFY gas]
       in_flight.state = Submitted{balance_before: ft_balance_of snapshot taken in precheck}
       emit action_submitted
sync_position()  (agent's next transaction, or owner)
  join(BURROW.get_account_all_positions(vault), token.ft_balance_of(vault), prices…)
  .then(on_sync): compare debt/balance vs. before → emit action_settled{actual} or action_failed; store HF; unlock
```
A borrow has three possible outcomes, and `on_sync` must distinguish them by reading Burrow's `collateral`, `borrowed` **and `supplied`** lists plus the vault's token balance:
1. Success: debt up, vault token balance up (expect up to 1 unit less than requested due to rounding).
2. Price callback failed: nothing changed.
3. Borrow succeeded but the transfer to the vault failed: debt up, the tokens sit in Burrow as plain `supplied`. Follow up with `simple_withdraw`.

`get_account_all_positions` shape: `positions.REGULAR.{collateral, borrowed}[]` with `{token_id, balance, shares, apr}`; `balance` is in inner decimals with interest accrued to now. Returns `null` if the account isn't registered.
For withdrawing plain supplied tokens, prefer `simple_withdraw(token_id, amount, recipient_id: null)`: unlike `execute_with_pyth`, its result can be awaited.
Withdraw collateral uses the same shape with `DecreaseCollateral` + `Withdraw`. If there is no debt, it can use `execute` (no prices needed).

### 6.3 Swap on Ref (deposit model, output verified on-chain)
```
agent_swap_ref(pool_id, token_in, token_out, amount_in)
  checks: pool_id ∈ allowed_ref_pools, both tokens allowed, caps → reserve; in_flight = {Swap, Started}
  join(ORACLE price(token_in), ORACLE price(token_out), REF.get_pool(pool_id))
  .then(on_swap_precheck)
on_swap_precheck:
  verify pool's token_account_ids contains exactly token_in and token_out (blocks fake-token pools)
  min_out = amount_in × p_in / p_out × (10_000 − max_slippage_bps) / 10_000   (decimal-adjusted, §8)
  token_in.ft_transfer_call(REF, amount_in, msg = "")  .then(on_ref_deposited)
on_ref_deposited(used): if used < amount_in → stop, withdraw what's there, fail
  REF.swap({actions:[{pool_id, token_in, token_out, amount_in, min_amount_out: min_out}]})
      (no 1 yocto needed; both tokens must be registered in the vault's Ref account via register_tokens,
       which does need 1 yocto. Returns amount_out, already credited to the vault's Ref balance.)
  .then(on_ref_swapped)
on_ref_swapped: Ok(amount_out) → REF.withdraw(token_out, amount_out) 1 yocto .then(on_ref_withdrawn)
                Err            → REF.withdraw(token_in, amount_in) 1 yocto .then(on_ref_withdrawn)   (refund path)
on_ref_withdrawn: emit action_settled{actual_out} or action_failed; release reservation on failure; unlock
```
- `min_out` is always computed by the vault. The agent never supplies it. Ref enforces it on the final hop; single-pool swaps only, so there are no unchecked intermediate hops (lesson from the Rhea exploit).
- `REF.withdraw(token, amount, skip_unwrap_near: true)` needs 1 yocto. If the token transfer fails (e.g. vault not registered on the token), Ref re-credits the deposit and returns 0, so `on_ref_withdrawn` must treat 0 as failure and leave funds recoverable via `recover_ref_deposits`.
- Max gas per transaction is now 1000 Tgas; the whole chain is estimated at 150–220 Tgas. **[VERIFY with sandbox gas profiling]**
- Default allowlisted pool: **4512** (wNEAR/USDC simple pool, 0.30% fee, ~$2.4M liquidity, the deepest on Rhea). wNEAR/USDT deep liquidity is only in degen pool 6063 (needs testing first). Don't use concentrated-liquidity (dclv2) pools in the vault: they don't return the output amount.
- `recover_ref_deposits()` (agent or owner): withdraws any stray Ref deposit balances back to the vault.

### 6.4 NEAR Intents routing
Danger: a 1Click `depositAddress` is opaque. Without proof of where the output goes, the agent could pass a quote whose recipient is the attacker. So **agent routing requires a verified 1Click quote signature**; without `intents_quote_pubkey` the method is disabled and only owner-signed Intents actions are possible.
```
agent_route_intents(quote_json: String, signature: String)
  signed message = ASCII string base58(sha256(stable_stringify(quote subset + timestamp))) — see near-intents skill
  (1Click public key: ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc, hard-coded in the 1Click SDK).
  The agent passes the exact canonical JSON string; the vault hashes, verifies, then parses that same string.
  ed25519_verify(signature, message, intents_quote_pubkey) else fail
  parse quote_json: originAsset, destinationAsset, amountIn, minAmountOut, recipient, refundTo,
                    depositType, recipientType, refundType, depositAddress, deadline
  require: depositType = recipientType = refundType = INTENTS;
           recipient == vault && refundTo == vault;
           deadline > now; assets ∈ allowed_tokens;
           minAmountOut ≥ oracle_expected × (1 − max_slippage)  (oracle check needs a precheck hop as in §6.3)
  caps → reserve; in_flight = {Intents, Started}
  token_in.ft_transfer_call(INTENTS, amountIn, msg = "")  → vault's Intents balance
  .then: INTENTS.mt_transfer(depositAddress, "nep141:<token_in>", amountIn) 1 yocto
         (the documented way for keyless contracts; NEAR DevHub's Trezu treasury does this in production)
  state = Submitted
sync_position: read INTENTS.mt_balance_of(vault, "nep141:<token_out>") → settle; output stays in Intents until
agent_intents_withdraw(token, amount) → INTENTS.ft_withdraw(token, vault, amount) with NO msg (refundable on failure)
```
Never call `intents.near add_public_key` from the vault. Any key registered there has unrestricted control of the vault's Intents balance.

Inbound funding (user bridges BTC/ETH/SOL/USDC in) needs no vault method: 1Click/POA delivers to `vault` (NEP-141) or to the vault's Intents balance; the owner or agent pulls it with `agent_intents_withdraw`.

---

## 7. Concurrency and failure rules

1. **One operation at a time** (`in_flight` mutex). Between a call and its callback any public method can run; the lock prevents a second agent action from interleaving. Owner methods ignore the lock (they never depend on in-flight accounting), except `owner_burrow`, which also takes the lock.
2. **Reserve before, settle after.** Daily-cap spend is reserved before funds leave and released only if the callback proves nothing left.
3. **Callbacks never panic.** Use `#[callback_result]`; on any error, emit `action_failed`, release, unlock. Each callback gets a fixed gas budget measured in sandbox tests + 30% margin.
4. **Settle from real balances.** Final amounts come from `ft_balance_of` / Burrow positions / Intents balances, not from expected values.
5. **Stale locks.** If an op is stuck past `STALE_LOCK_SECS`, `sync_position` or owner `clear_stale_lock` resolves it.
6. **Promise states:** `Started` (nothing left the vault yet) → `Submitted` (funds sent / external call fired) → cleared. Only `Started` ops can release reservations blindly.

---

## 8. Math

- **Prices** from `aggregate-oracle.near get_price_no_older_than(price_id, age)` → `{price: i64, conf: u64, expo: i32, publish_time}`. Prices update ~every 30 s; use age = 60 s (same as Burrow). Never use `get_price_unsafe`. Reject if `None`, `price ≤ 0`, `publish_time` older than `max_price_age_sec`, or `conf × 10_000 / price > max_price_conf_bps`. Same oracle Burrow uses, so our HF matches Burrow's liquidation math.
- **Value** of `amount` of token `t` in USD (fixed point, 1e18): `amount × price × 10^expo / 10^decimals(t)`. Do all math in `u128` with checked ops; use `U256` (e.g. `uint` crate) for intermediates.
- **Burrow amounts**: Burrow balances use inner decimals `decimals + extra_decimals`. Convert before valuing.
- **Health factor** (Burrow formula):
  `HF = Σ collateral_value(t) × vol(t) / Σ debt_value(t) / vol(t)`, with `vol` = `volatility_ratio_bps / 10_000`.
  No debt → HF = ∞ (all checks pass). Represent HF in bps (15000 = 1.5).
- **Swap min_out**: `min_out = amount_in × value_per_unit(in) / value_per_unit(out) × (10_000 − max_slippage_bps) / 10_000`, converted to `token_out` units, rounded down.
- **Day index**: `block_timestamp / 86_400_000_000_000`.

---

## 9. Events (NEP-297)

Format: `EVENT_JSON:{"standard":"trellis_vault","version":"1.0.0","event":"<name>","data":[{...}]}`

| Event | Data |
|---|---|
| `deposit` | token, amount, sender |
| `action_started` | op_id, kind, token_in, amount_in, token_out?, reason_hash |
| `action_submitted` | op_id, external call summary |
| `action_settled` | op_id, kind, actual_in, actual_out, health_factor_bps?, day_spent, reason_hash |
| `action_failed` | op_id, kind, reason (enum: `policy`, `stale_price`, `slippage`, `external_failed`, `timeout`) |
| `policy_violation` | op_id?, rule, attempted value, limit |
| `policy_changed` / `agent_set` / `agent_revoked` / `paused` / `unpaused` | new values |
| `owner_withdraw` | token, amount |

The last 50 `action_*` events are also stored in `receipts` so the dashboard can read them with one view call. Events are authenticated by the chain itself, so no separate agent signature is needed (unlike the Sui version). `reason_hash` links to the agent's off-chain reasoning record (and, if used, the NEAR AI signed response).

---

## 10. Security checklist

| Risk | Mitigation |
|---|---|
| Agent sends funds to an outside address | No agent method takes a free-form recipient. Owner withdrawals go only to `owner`. Protocol ids are hardcoded. |
| Agent passes raw protocol messages (side doors like Burrow margin or arbitrary `execute` actions) | The vault builds every outbound message itself from typed params. No passthrough for the agent. |
| Fake tokens / manipulated pools (Rhea April 2026) | Token allowlist + pool allowlist + check pool's token pair + oracle-derived `min_out` + single-hop swaps + settle from actual balance. |
| Stale or manipulated oracle price | Freshness and confidence checks; reject on any missing price. |
| HF pushed too low | Vault computes projected HF before borrow/withdraw; floor configurable; deleverage only allowed to the emergency floor. |
| Intents side door | Never register keys on `intents.near`; agent routing requires a verified 1Click quote with `recipient == refundTo == vault`. |
| Interleaving / accounting drift | Single lock, reserve-then-settle, non-panicking callbacks, settle from real balances, stale-lock escape. |
| Agent key leak | FC key per vault, method-limited, gas allowance; `predecessor` check; owner can revoke instantly; caps bound the damage. |
| Owner methods called by agent / dapp key | `assert_one_yocto` on all owner methods. |
| Vault runs out of NEAR for storage / 1 yocto | `min_near_reserve`, `max_storage_spend`; owner tops up. |
| Funds stuck because a protocol is paused | `withdraw_ft`/`withdraw_near` don't depend on protocols; `owner_burrow` lets the owner close positions manually. |
| Upgrade abuse | Only the owner can upgrade; factory has no rights; vault has no access keys. |

---

## 11. Test plan

**Unit tests** (near-sdk `testing_env!`): policy validation, cap reservation/release, day rollover, HF math (known vectors from Burrow), min_out math with decimals, every auth check (agent vs owner vs stranger, paused, expired, attached deposit).

**Sandbox integration** (near-workspaces 0.23): import wasm of `wrap.near`, a mock USDC, `v2.ref-finance.near`, `contract.main.burrow.near`; deploy `contracts/test-oracle` from the burrowland repo (or a minimal mock implementing `get_price_no_older_than`); initialize and seed pools ourselves.
- Happy paths: supply, borrow, repay, withdraw, swap, deleverage sequence, owner withdraw.
- Attacks: fake-token pool, pool not allowlisted, slippage beyond limit (move pool price), stale price, wide conf, borrow that would breach min HF, second action while locked, callback failure paths (token without storage, Ref swap failure → refund path), agent calling owner methods, agent after revoke/expiry/pause.
- Gas profiling of each chain to fix callback gas constants.

**Mainnet smoke tests** (small amounts, test owner account): full loop on Burrow, one Ref swap, one Intents route + withdraw.

---

## 12. Open questions / [VERIFY] list
Resolved on 2026-10-22 (details in the skills under `.claude/skills/`):
1. ✅ Supply-as-collateral msg `"\"OnlyIncreaseCollateral\""`; repay `"\"OnlyRepay\""` (§6.1).
2. ✅ Position shape (§6.2).
3. ✅ Ref `swap` needs no 1 yocto; `withdraw` does (§6.3).
4. ✅ Global contracts supported; reference by hash (§3).
5. ✅ 1Click signed bytes + public key (§6.4).
6. ✅ Fund via `mt_transfer(depositAddress)` (§6.4).
7. ✅ Oracle callable cross-contract (Burrow does it).

Still open:
- Gas constants for every chain (sandbox profiling). Measured 2026-10-22: a full borrow (`execute_with_pyth` + 2 oracle calls + callback + transfer) burns ~20 Tgas; supply via `ft_transfer_call` ~9 Tgas. Keep generous margins (forward ≥100 Tgas to `execute_with_pyth`); Ref chain still unmeasured.
- ✅ Sandbox borrow flow verified (fresh price, stale price, HF breach, repay overpay, withdraw all). Test: `.claude/skills/near-contract-testing/examples/borrow_flow.rs`.
- Burrow v0.16 behavior (deployed source isn't public): Maintenance mode, pause, `min_borrowed_amount` enforcement.
- Whether 1Click detects funding via `ft_transfer_call(msg = depositAddress)` (we use `mt_transfer`, so low priority).
- Who operates `aggregate-oracle.near` (source not public). Disclose in the security write-up, along with the Intents DAO's admin powers (pause, upgrade, lock accounts, force-withdraw).

## 12a. Strategy parameters (from the lending research)
- Theoretical max leverage wNEAR collateral / USDC debt: 3.48x. **Target 1.8–1.9x (HF 1.5–1.6)**. At 2.5x the HF is ~1.19 and a ~16% NEAR drop triggers liquidation.
- Suggested defaults: `min_health_factor_bps = 15000`, deleverage trigger 13000, `emergency_floor_bps = 11000`.
- Borrow cost matters: native USDC was ~94% utilized with ~32.6% borrow APR on 2026-10-22, which lowers HF ~2.6%/month at a flat price. The agent should check the borrow APR before looping and show it in the Guardian.

---

## 13. Build order
1. Skeleton: state, owner methods, deposits, policy validation, events, unit tests.
2. Burrow supply/repay (no prices) + `withdraw_ft`.
3. Oracle reads + HF math + borrow/withdraw-collateral with precheck + `sync_position`.
4. Ref swap chain + pool checks.
5. Factory + global contract deployment.
6. Intents routing (only if quote-signature verification is confirmed; otherwise owner-only Intents).

---

## 14. Implementation notes (v0.1 built 2026-10-22)

Code: `contracts/vault`, `contracts/factory`, `contracts/mock-oracle`, tests in `contracts/integration-tests`.
Differences from the draft above, all deliberate:

- **Agent is stored outside the policy** (`set_agent(agent, expires_at)` / `revoke_agent()`), so `set_policy` can never change or clear the agent by accident.
- **`deleverage_trigger_bps` added to the policy.** `agent_withdraw_collateral(deleverage = true)` is only allowed while the current HF is below the trigger; it may then go down to `emergency_floor_bps`. Validation: `floor < trigger <= min_health_factor`.
- **Extra recovery methods** (funds only move into the vault): `agent_withdraw_supplied(token)` (Burrow "supplied" balance, e.g. repay overpayment or a borrow whose transfer failed), `recover_ref(token)` (whole Ref deposit; agent when idle, or owner).
- **Extra owner methods:** `owner_ft_transfer_call(token, receiver, amount, msg)` restricted to Burrow / Ref / Intents (e.g. repay debt after revoking the agent), `owner_intents_withdraw`.
- **Prices for every registered token** are read in each borrow/withdraw precheck (registered tokens are capped at 10), so the HF calculation never misses a position token. Unknown tokens in the Burrow position make the precheck fail (conservative).
- **`sync_position` waits ≥ 5 s** after submission (`ERR_SYNC_TOO_EARLY`) so Burrow's internal receipts have finished; it dispatches to Intents reconciliation when the in-flight op is an Intents route.
- **Intents:** replay protection (`used_quotes`, sha256 of each signed quote); the quoted `minAmountOut` must be ≥ the oracle price minus policy slippage; Intents balances of both tokens are snapshotted before funding to detect settlement or refund.
- **Owner `upgrade(code_hash)`** switches the vault to a new global contract by hash, then calls `migrate`.
- **Decision (2026-10-22): mainnet uses Global mode** so users deposit only 1.5 NEAR per vault. The admin publishes the vault code once with the factory's `publish_global_code` (sandbox-tested: 369 KB cost 37.87 NEAR, burned, paid by us); the factory then switches to `Global { code_hash }` automatically. Shrinking the wasm later lowers that one-time cost (~10 NEAR per 100 kB); each new code version must be published again and vault owners opt in via `upgrade(code_hash)`.
- **Factory** supports two code modes: `Global { code_hash }` (reference by hash; publishing burns ~10 NEAR per 100 kB once, ~40 NEAR (398 KB after the security fixes, §15) for the current 379 kB wasm) and `Local` (factory stores the wasm and deploys a copy; each vault locks ~3.8 NEAR, so the minimum deposit is ~5.3 NEAR). Vault names are `v<16 hex of sha256(owner)>.<factory>`. On a failed batch the deposit is refunded. The factory takes optional `protocols` at init (fixed afterwards, no setter) and passes them to every vault's `new`; omitted means the mainnet contracts. The testnet deployment uses it to bind vaults to its own Burrow, Ref and oracle (2026-11-08).

**Measured gas (sandbox, real Burrow/Ref wasm):** supply ~15 Tgas, borrow (precheck + execute_with_pyth + oracle + callbacks) ~39 Tgas, full Ref swap chain ~41 Tgas. The agent attaches 300 Tgas.

**Test status:** 34 vault unit tests + 4 factory unit tests; 8 sandbox tests (happy path supply → borrow → sync → swap → repay; HF breach; stale price; wrong-pair pool; slippage refund; access control incl. private callbacks, non-payable agent methods, pause, revoke, owner withdraw while paused; deleverage guard; factory). Not yet covered in sandbox: Intents routing (no Intents testnet; signature checks are unit-tested with a real 1Click quote; needs a small mainnet smoke test).

**Worker end-to-end test (2026-10-22):** `contracts/integration-tests/tests/worker_e2e.rs` runs the real Node worker against the sandbox. After a NEAR price crash to $1.80 (HF 1.28 < trigger 1.3) the worker withdrew 2.38 wNEAR (HF → 1.13 = floor + margin), swapped it to 11.58 USDC on Ref, and repaid: HF 2.68 within ~20 s. The owner-approved plan API ran a supply step to completion.

## 15. Security review fixes (2026-10-22)

An independent review of the vault and factory found no critical or high issues, 4 medium, 6 low and 4 info (14 in total). All are fixed, and each has a test. Where this section disagrees with an earlier one, this section wins.

| # | Finding | Fix | Test |
|---|---|---|---|
| M1 | Intents: unsigned `appFees` let a quote skim up to the slippage limit to any account | The signed `amountOut` must be within the new policy field `max_intents_spread_bps` of the oracle price (default 50, must be ≤ `max_slippage_bps`). Fees come out of `amountOut`, so this caps them. `minAmountOut ≤ amountOut` is also required. | `intents_quote_with_skimmed_output_is_rejected` |
| M2 | Intents: signed fields the vault didn't know about were ignored | `SignedQuote` uses `deny_unknown_fields` with every field 1Click signs listed. `virtualChainRecipient`, `virtualChainRefundRecipient`, `customRecipientMsg` and `depositMemo` must be absent. | `intents_quote_rejects_delivery_and_unknown_fields` |
| M3 | A borrow or withdraw was declared "not executed" 5 s after submission, so a second borrow could stack on a pending one | "No effect yet" stays pending until `SYNC_FINAL_NS` (3 min); the lock holds meanwhile. The worker keeps syncing for 200 s. | `borrow_sync_stays_pending_until_final`, `borrow_sync_settles_as_soon_as_visible` |
| M4 | A deleverage withdrawal could park the HF at the emergency floor indefinitely | (a) Policy needs `deleverage_trigger + 500 ≤ min_health_factor`. (b) A settled deleverage withdrawal opens `pending_deleverage` (shown in `get_status`). Until the withdrawn collateral is swapped (into one debt token) and the proceeds repaid, or supplied back, the agent may only: swap that collateral, repay, supply that collateral, `agent_withdraw_supplied`, `agent_intents_withdraw`, `agent_wrap_near`, `sync_position`, `recover_ref`. Borrow, other withdrawals, other swaps and Intents routes fail with `ERR_DELEVERAGE_PENDING`. Repaying the full debt also closes it. The owner can end it with `clear_deleverage`. | `deleverage_*` tests, `policy_needs_gap_between_trigger_and_min`, worker e2e |
| L5 | Cached Burrow risk settings could go stale | The borrow/withdraw precheck also reads Burrow `get_assets` and refreshes `volatility_ratio` and `extra_decimals` before computing HF. | `token_config_refreshes_from_burrow` |
| L6 | `used_quotes` grew on every attempt, and storage could eat the NEAR reserve | Quotes are marked used only once funded. `begin_op` checks the NEAR reserve after its own state writes. | `intents_quote_marked_used_only_when_funded`, `near_reserve_is_kept` |
| L7 | `clear_stale_lock` released caps for ops whose funds had already left | `PendingOp.funds_sent` is set before any transfer out (supply, repay, wrap, swap deposit, Intents deposit); clearing then keeps the reservation. | `clear_stale_lock_*` |
| L8 | `agent_repay` wasn't bounded by the debt | Repay now reads positions first and sends `min(amount, debt + 1 unit)`; no debt → fails `no_debt`. | `repay_is_capped_at_debt`, `repay_without_debt_fails` |
| L9 | Pause / feature flags missing on return-funds methods; wrap uncapped | `recover_ref` (agent) needs not paused + `ref_enabled`; `agent_withdraw_supplied` needs `burrow_enabled`; `agent_wrap_near` needs wNEAR allowed and counts against its caps (released if the wrap fails). | `recover_ref_respects_pause_for_agent`, `withdraw_supplied_needs_burrow_enabled`, `wrap_counts_against_wnear_cap` |
| L10 | Factory refund on a failed batch depended on receipt order | The failed vault is forgotten (the owner can retry). The deposit is sent back if the factory's free balance covers it; otherwise it is recorded for `claim_refund` (`get_refund` view). | sandbox `factory_refunds_failed_creation` |
| Info | `ft_withdraw` result ignored | Receipt records the amount Intents returned (0 → `intents_withdraw_refunded`). | `intents_withdraw_records_actual_amount` |
| Info | `owner_burrow` didn't take the lock | `owner_burrow` and `owner_ft_transfer_call` require no agent op in flight. | `owner_burrow_waits_for_agent_op` |
| Info | `conf` / `expo` truncated silently | Parsed with `try_from`; out of range → price unreadable. | — |
| Info | Gas with many tokens | `MAX_REGISTERED_TOKENS` = 5; borrow precheck budget = 8 views × 10 + 200 = 280 Tgas, under the worker's 300. Measured burn: borrow 91 Tgas, repay 24, swap 81, supply 29. | sandbox happy path |

Code size after the fixes: 398 KB (was 379 KB); the one-time global publish costs about 40 NEAR.

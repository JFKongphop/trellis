use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

/// Protocol contracts the vault talks to. Set once at init and never changeable afterwards,
/// so a bad policy can't redirect funds to a look-alike contract.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Protocols {
    pub burrow: AccountId,
    pub ref_exchange: AccountId,
    pub oracle: AccountId,
    pub intents: AccountId,
    pub wrap: AccountId,
}

impl Protocols {
    pub fn mainnet() -> Self {
        Self {
            burrow: "contract.main.burrow.near".parse().unwrap(),
            ref_exchange: "v2.ref-finance.near".parse().unwrap(),
            oracle: "aggregate-oracle.near".parse().unwrap(),
            intents: "intents.near".parse().unwrap(),
            wrap: "wrap.near".parse().unwrap(),
        }
    }
}

/// What the vault knows about a token. Filled by `register_token` from the token and Burrow.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenInfo {
    /// `ft_metadata.decimals`
    pub decimals: u8,
    /// Burrow `extra_decimals`: Burrow amounts use `decimals + extra_decimals` ("inner" units).
    pub burrow_extra_decimals: u8,
    /// Oracle price id (64-char hex) from Burrow `get_token_pyth_info`.
    pub price_id: String,
    /// Burrow collateral factor in bps (e.g. wNEAR 7500).
    pub volatility_ratio_bps: u32,
}

impl TokenInfo {
    pub fn inner_decimals(&self) -> u32 {
        self.decimals as u32 + self.burrow_extra_decimals as u32
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpKind {
    WrapNear,
    Supply,
    Repay,
    Borrow,
    WithdrawCollateral,
    WithdrawSupplied,
    SwapRef,
    RecoverRef,
    IntentsRoute,
    IntentsWithdraw,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpState {
    /// Checks/prechecks running; nothing has left the vault yet.
    Started,
    /// External call fired; result must be reconciled (`sync_position`).
    Submitted,
}

/// The single in-flight agent operation (mutex). Holds everything callbacks need.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingOp {
    pub op_id: U64,
    pub kind: OpKind,
    pub state: OpState,
    pub started_at: U64,
    pub submitted_at: Option<U64>,
    pub token_in: Option<AccountId>,
    pub amount_in: U128,
    pub token_out: Option<AccountId>,
    /// Amount reserved against the daily cap of `token_in` (0 for uncapped kinds).
    pub reserved: U128,
    /// Day index the reservation belongs to.
    pub day: U64,
    pub reason_hash: String,
    /// Swap/route specifics.
    pub pool_id: Option<u64>,
    pub min_out: U128,
    /// Snapshots for reconciliation (vault balance of the relevant token, Burrow shares).
    pub balance_before: Option<U128>,
    pub shares_before: Option<U128>,
    /// 1Click deposit address for Intents routes.
    pub deposit_address: Option<String>,
    /// `agent_withdraw_collateral(deleverage = true)`.
    pub deleverage: bool,
    /// Funds have left the vault (a transfer to a protocol was fired). `clear_stale_lock` then keeps
    /// the cap reservation, because the funds may already be spent.
    pub funds_sent: bool,
    /// sha256 of the signed 1Click quote (Intents routes); marked used once the route is funded.
    pub quote_hash: Option<String>,
}

/// Set after a deleverage withdrawal. Until the withdrawn collateral has been swapped and the
/// proceeds repaid (or the collateral supplied back), the agent may only finish that cycle:
/// swap `collateral_token`, repay, supply `collateral_token`, or pull funds back into the vault.
/// This stops an agent from lowering the health factor to the emergency floor and leaving it there.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingDeleverage {
    pub collateral_token: AccountId,
    /// Withdrawn collateral still to be swapped or supplied back (token base units).
    pub collateral_left: U128,
    /// Token the collateral was swapped into (set by the first swap).
    pub debt_token: Option<AccountId>,
    /// Swap proceeds still to be repaid (base units of `debt_token`).
    pub repay_due: U128,
    pub started_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiptStatus {
    Settled,
    Failed,
}

/// Compact record of a finished agent action, kept in a ring buffer for the dashboard.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ReceiptView {
    pub op_id: U64,
    pub kind: OpKind,
    pub status: ReceiptStatus,
    pub token_in: Option<AccountId>,
    pub amount_in: U128,
    pub token_out: Option<AccountId>,
    pub amount_out: U128,
    pub health_factor_bps: Option<U64>,
    pub note: String,
    pub reason_hash: String,
    pub timestamp: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct HealthSnapshot {
    /// Health factor in bps (15000 = 1.5). `u64::MAX` = no debt.
    pub health_factor_bps: U64,
    pub collateral_usd_e18: U128,
    pub debt_usd_e18: U128,
    pub timestamp: U64,
}

/// Oracle price as returned by `get_price_no_older_than` (Pyth style).
#[derive(Clone, Debug, PartialEq)]
pub struct Price {
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
}

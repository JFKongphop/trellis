//! NEP-297 events, standard "trellis_vault". All amounts are U128 strings.
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

use crate::types::OpKind;

#[near(serializers = [json])]
pub struct ActionData {
    pub op_id: U64,
    pub kind: OpKind,
    pub token_in: Option<AccountId>,
    pub amount_in: U128,
    pub token_out: Option<AccountId>,
    pub amount_out: U128,
    pub health_factor_bps: Option<U64>,
    pub note: String,
    pub reason_hash: String,
}

#[near(event_json(standard = "trellis_vault"))]
pub enum VaultEvent {
    #[event_version("1.0.0")]
    Deposit { token: AccountId, amount: U128, sender: AccountId },
    #[event_version("1.0.0")]
    ActionStarted(Vec<ActionData>),
    #[event_version("1.0.0")]
    ActionSubmitted(Vec<ActionData>),
    #[event_version("1.0.0")]
    ActionSettled(Vec<ActionData>),
    #[event_version("1.0.0")]
    ActionFailed(Vec<ActionData>),
    #[event_version("1.0.0")]
    PolicyViolation { op_id: Option<U64>, rule: String, value: String, limit: String },
    #[event_version("1.0.0")]
    HealthAlert { health_factor_bps: U64, min_health_factor_bps: U64 },
    #[event_version("1.0.0")]
    PolicyChanged,
    #[event_version("1.0.0")]
    AgentSet { agent: AccountId, expires_at: Option<U64> },
    #[event_version("1.0.0")]
    AgentRevoked,
    #[event_version("1.0.0")]
    Paused,
    #[event_version("1.0.0")]
    Unpaused,
    #[event_version("1.0.0")]
    TokenRegistered { token: AccountId },
    #[event_version("1.0.0")]
    OwnerWithdraw { token: Option<AccountId>, amount: U128 },
    #[event_version("1.0.0")]
    LockCleared { op_id: U64 },
}

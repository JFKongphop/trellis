use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, NearToken};

/// Rules the owner sets. The agent can only act inside them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// Every token in or out of any agent action must be listed here.
    pub allowed_tokens: Vec<AccountId>,
    /// Ref v2 pool ids the agent may swap through (single hop only).
    pub allowed_ref_pools: Vec<u64>,

    /// Max amount of a token sent out in one agent action (token base units).
    pub per_action_cap: Vec<(AccountId, U128)>,
    /// Max amount of a token sent out per UTC day (token base units).
    pub daily_cap: Vec<(AccountId, U128)>,

    /// Max slippage vs. the oracle price, in bps (100 = 1%).
    pub max_slippage_bps: u16,
    /// Intents routes: the quote's signed `amountOut` must be within this many bps of the oracle
    /// price. Tight on purpose: 1Click fees (including unsigned `appFees` that anyone requesting the
    /// quote can add) come out of `amountOut`, so this caps what a quote can skim.
    pub max_intents_spread_bps: u16,
    /// The agent may never push the health factor below this (bps; 15000 = 1.5).
    pub min_health_factor_bps: u32,
    /// Below this health factor, deleverage steps are allowed.
    pub deleverage_trigger_bps: u32,
    /// Deleverage steps may temporarily lower the health factor down to this floor.
    pub emergency_floor_bps: u32,
    /// Oracle freshness limit in seconds.
    pub max_price_age_sec: u32,
    /// Reject prices whose confidence interval is wider than this (bps of price).
    pub max_price_conf_bps: u16,

    pub burrow_enabled: bool,
    pub ref_enabled: bool,
    pub intents_enabled: bool,
    /// 1Click quote-signing key ("ed25519:<base58>"). Agent Intents routing is off when None.
    pub intents_quote_pubkey: Option<String>,

    /// The vault never spends NEAR below this (keeps gas/storage/1-yocto calls working).
    pub min_near_reserve: NearToken,
    /// Total NEAR the vault may spend on storage deposits.
    pub max_storage_spend: NearToken,
}

pub const MAX_TOKENS: usize = 10;
pub const MAX_POOLS: usize = 20;
/// The deleverage trigger must sit at least this far below the minimum health factor, so the
/// agent can't borrow to the minimum and then cross the trigger on interest alone.
pub const MIN_DELEVERAGE_GAP_BPS: u32 = 500;

impl Default for Policy {
    /// Safe default: nothing allowed until the owner sets a policy.
    fn default() -> Self {
        Self {
            allowed_tokens: vec![],
            allowed_ref_pools: vec![],
            per_action_cap: vec![],
            daily_cap: vec![],
            max_slippage_bps: 100,
            max_intents_spread_bps: 50,
            min_health_factor_bps: 15_000,
            deleverage_trigger_bps: 13_000,
            emergency_floor_bps: 11_000,
            max_price_age_sec: 60,
            max_price_conf_bps: 100,
            burrow_enabled: false,
            ref_enabled: false,
            intents_enabled: false,
            intents_quote_pubkey: None,
            min_near_reserve: NearToken::from_millinear(500),
            max_storage_spend: NearToken::from_near(1),
        }
    }
}

impl Policy {
    /// Returns an error message if the policy is unsafe or inconsistent.
    pub fn validate(&self) -> Result<(), String> {
        if self.allowed_tokens.len() > MAX_TOKENS {
            return Err(format!("At most {MAX_TOKENS} allowed tokens"));
        }
        if self.allowed_ref_pools.len() > MAX_POOLS {
            return Err(format!("At most {MAX_POOLS} allowed pools"));
        }
        if has_duplicates(&self.allowed_tokens) {
            return Err("Duplicate allowed token".into());
        }
        for (name, caps) in [("per_action_cap", &self.per_action_cap), ("daily_cap", &self.daily_cap)] {
            let ids: Vec<AccountId> = caps.iter().map(|(t, _)| t.clone()).collect();
            if has_duplicates(&ids) {
                return Err(format!("Duplicate token in {name}"));
            }
            for (t, c) in caps {
                if !self.allowed_tokens.contains(t) {
                    return Err(format!("{name}: {t} is not an allowed token"));
                }
                if c.0 == 0 {
                    return Err(format!("{name}: cap for {t} must be > 0"));
                }
            }
        }
        for (t, per) in &self.per_action_cap {
            match self.daily_cap_of(t) {
                Some(d) if per.0 <= d => {}
                Some(_) => return Err(format!("per_action_cap for {t} exceeds its daily_cap")),
                None => return Err(format!("{t} has a per_action_cap but no daily_cap")),
            }
        }
        if self.max_slippage_bps == 0 || self.max_slippage_bps > 500 {
            return Err("max_slippage_bps must be 1..=500".into());
        }
        if self.max_intents_spread_bps == 0 || self.max_intents_spread_bps > self.max_slippage_bps {
            return Err("max_intents_spread_bps must be 1..=max_slippage_bps".into());
        }
        if self.emergency_floor_bps < 10_500 {
            return Err("emergency_floor_bps must be >= 10500 (1.05)".into());
        }
        if self.min_health_factor_bps < 11_000 {
            return Err("min_health_factor_bps must be >= 11000 (1.1)".into());
        }
        if !(self.emergency_floor_bps < self.deleverage_trigger_bps
            && self.deleverage_trigger_bps.saturating_add(MIN_DELEVERAGE_GAP_BPS) <= self.min_health_factor_bps)
        {
            return Err(format!(
                "Need emergency_floor < deleverage_trigger, and deleverage_trigger + {MIN_DELEVERAGE_GAP_BPS} <= min_health_factor"
            ));
        }
        if self.max_price_age_sec < 10 || self.max_price_age_sec > 300 {
            return Err("max_price_age_sec must be 10..=300".into());
        }
        if self.max_price_conf_bps == 0 || self.max_price_conf_bps > 500 {
            return Err("max_price_conf_bps must be 1..=500".into());
        }
        if self.min_near_reserve < NearToken::from_millinear(100) {
            return Err("min_near_reserve must be >= 0.1 NEAR".into());
        }
        if let Some(pk) = &self.intents_quote_pubkey {
            crate::math::parse_ed25519_pubkey(pk).map_err(|e| format!("intents_quote_pubkey: {e}"))?;
        }
        Ok(())
    }

    pub fn is_allowed(&self, token: &AccountId) -> bool {
        self.allowed_tokens.contains(token)
    }

    pub fn per_action_cap_of(&self, token: &AccountId) -> Option<u128> {
        self.per_action_cap.iter().find(|(t, _)| t == token).map(|(_, c)| c.0)
    }

    pub fn daily_cap_of(&self, token: &AccountId) -> Option<u128> {
        self.daily_cap.iter().find(|(t, _)| t == token).map(|(_, c)| c.0)
    }
}

fn has_duplicates(ids: &[AccountId]) -> bool {
    ids.iter().enumerate().any(|(i, a)| ids[i + 1..].contains(a))
}

//! Minimal stand-in for `aggregate-oracle.near` (Pyth-style interface used by Burrow
//! `execute_with_pyth`). JSON shapes copied from burrowland contracts/mock-pyth and
//! checked against a live mainnet `get_price_no_older_than` response.
use near_sdk::json_types::{I64, U64};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// `{"price":"534952557","conf":"264110","expo":-8,"publish_time":1792606342}`
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PythPrice {
    pub price: I64,
    pub conf: U64,
    pub expo: i32,
    /// unix SECONDS
    pub publish_time: i64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOracle {
    owner: AccountId,
    /// key = 64-char lowercase hex price id (same string Burrow's get_token_pyth_info returns)
    prices: IterableMap<String, PythPrice>,
}

#[near]
impl MockOracle {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, prices: IterableMap::new(b"p") }
    }

    pub fn set_price(&mut self, price_identifier: String, pyth_price: PythPrice) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
        require!(price_identifier.len() == 64, "expected 64-char hex price id");
        self.prices.insert(price_identifier, pyth_price);
    }

    pub fn remove_price(&mut self, price_identifier: String) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
        self.prices.remove(&price_identifier);
    }

    pub fn get_price(&self, price_identifier: String) -> Option<PythPrice> {
        self.prices.get(&price_identifier).cloned()
    }

    /// Same signature as Pyth / aggregate-oracle: returns None if older than `age` seconds,
    /// so you can test stale-price handling (Burrow's own mock ignores `age`).
    pub fn get_price_no_older_than(&self, price_id: String, age: u64) -> Option<PythPrice> {
        let now_sec = (env::block_timestamp() / 1_000_000_000) as i64;
        self.prices
            .get(&price_id)
            .filter(|p| now_sec.saturating_sub(p.publish_time) <= age as i64)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const NEAR_ID: &str = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";

    #[test]
    fn stale_price_is_none() {
        let owner: AccountId = "owner.near".parse().unwrap();
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(owner.clone()).block_timestamp(1_000 * 1_000_000_000);
        testing_env!(b.build());
        let mut o = MockOracle::new(owner);
        o.set_price(NEAR_ID.into(), PythPrice { price: I64(500_000_000), conf: U64(100_000), expo: -8, publish_time: 990 });
        assert!(o.get_price_no_older_than(NEAR_ID.into(), 60).is_some());
        testing_env!(b.block_timestamp(1_100 * 1_000_000_000).build());
        assert!(o.get_price_no_older_than(NEAR_ID.into(), 60).is_none());
        let j = near_sdk::serde_json::to_string(&o.get_price(NEAR_ID.into()).unwrap()).unwrap();
        assert_eq!(j, r#"{"price":"500000000","conf":"100000","expo":-8,"publish_time":990}"#);
    }
}

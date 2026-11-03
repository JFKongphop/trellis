//! Calls to external contracts and defensive parsing of their responses.
//! External responses are untrusted: everything is parsed from raw bytes and never panics.
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, AccountId, Gas, NearToken, Promise};

use crate::types::Price;

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
const MAX_RESULT_BYTES: usize = 32 * 1024;

pub mod gas {
    use near_sdk::Gas;
    pub const VIEW: Gas = Gas::from_tgas(10);
    pub const FT_TRANSFER: Gas = Gas::from_tgas(15);
    pub const FT_TRANSFER_CALL: Gas = Gas::from_tgas(80);
    pub const STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
    pub const WRAP: Gas = Gas::from_tgas(10);
    pub const BURROW_EXECUTE: Gas = Gas::from_tgas(60);
    pub const BURROW_EXECUTE_WITH_PYTH: Gas = Gas::from_tgas(150);
    pub const REF_SWAP: Gas = Gas::from_tgas(30);
    pub const REF_WITHDRAW: Gas = Gas::from_tgas(40);
    pub const REF_REGISTER: Gas = Gas::from_tgas(10);
    pub const INTENTS_CALL: Gas = Gas::from_tgas(30);
    pub const INTENTS_WITHDRAW: Gas = Gas::from_tgas(60);
    /// A callback that only settles (no further calls).
    pub const CB_SETTLE: Gas = Gas::from_tgas(20);
}

/// Function call to another contract with JSON args.
pub fn call(receiver: &AccountId, method: &str, args: Value, deposit: NearToken, gas: Gas) -> Promise {
    Promise::new(receiver.clone()).function_call(method.to_string(), args.to_string().into_bytes(), deposit, gas)
}

/// Callback into this contract (must be `#[private]` on our side).
pub fn callback(method: &str, args: Value, gas: Gas) -> Promise {
    call(&env::current_account_id(), method, args, NO_DEPOSIT, gas)
}

pub fn ft_balance_of(token: &AccountId, account: &AccountId) -> Promise {
    call(token, "ft_balance_of", json!({ "account_id": account }), NO_DEPOSIT, gas::VIEW)
}

pub fn oracle_price(oracle: &AccountId, price_id: &str, max_age_sec: u32) -> Promise {
    call(
        oracle,
        "get_price_no_older_than",
        json!({ "price_id": price_id, "age": max_age_sec }),
        NO_DEPOSIT,
        gas::VIEW,
    )
}

pub fn burrow_positions(burrow: &AccountId, account: &AccountId) -> Promise {
    call(burrow, "get_account_all_positions", json!({ "account_id": account }), NO_DEPOSIT, gas::VIEW)
}

/// Joins promises with `.and()`. Panics on an empty list (caller bug, not external input).
pub fn join(mut promises: Vec<Promise>) -> Promise {
    let first = promises.remove(0);
    promises.into_iter().fold(first, |acc, p| acc.and(p))
}

// ---------- reading results (in callbacks) ----------

pub fn result_count() -> u64 {
    env::promise_results_count()
}

/// Raw bytes of promise result `i`, or None if it failed / was too long / doesn't exist.
pub fn result_bytes(i: u64) -> Option<Vec<u8>> {
    if i >= env::promise_results_count() {
        return None;
    }
    env::promise_result_checked(i, MAX_RESULT_BYTES).ok()
}

pub fn result_json(i: u64) -> Option<Value> {
    let bytes = result_bytes(i)?;
    if bytes.is_empty() {
        return Some(Value::Null);
    }
    serde_json::from_slice(&bytes).ok()
}

/// A u128 returned as a JSON string ("123") or number.
pub fn result_u128(i: u64) -> Option<u128> {
    json_u128(&result_json(i)?)
}

pub fn json_u128(v: &Value) -> Option<u128> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64().map(|x| x as u128),
        _ => None,
    }
}

fn json_i64(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

/// Parses an oracle response `{"price","conf","expo","publish_time"}`; `null` → None.
pub fn parse_price(v: &Value) -> Option<Price> {
    let o = v.as_object()?;
    Some(Price {
        price: json_i64(o.get("price")?)?,
        conf: u64::try_from(json_u128(o.get("conf")?)?).ok()?,
        expo: i32::try_from(json_i64(o.get("expo")?)?).ok()?,
        publish_time: json_i64(o.get("publish_time")?)?,
    })
}

/// One entry of a Burrow position list (amounts in Burrow inner decimals).
#[derive(Clone, Debug, Default)]
pub struct PosEntry {
    pub token_id: String,
    pub balance: u128,
    pub shares: u128,
}

/// Parsed `get_account_all_positions` (regular position only; margin is not used).
#[derive(Clone, Debug, Default)]
pub struct Positions {
    pub collateral: Vec<PosEntry>,
    pub borrowed: Vec<PosEntry>,
    pub supplied: Vec<PosEntry>,
}

impl Positions {
    pub fn find<'a>(list: &'a [PosEntry], token: &AccountId) -> Option<&'a PosEntry> {
        list.iter().find(|e| e.token_id == token.as_str())
    }
}

fn parse_entries(v: Option<&Value>) -> Option<Vec<PosEntry>> {
    let arr = match v {
        None | Some(Value::Null) => return Some(vec![]),
        Some(Value::Array(a)) => a,
        _ => return None,
    };
    arr.iter()
        .map(|e| {
            Some(PosEntry {
                token_id: e.get("token_id")?.as_str()?.to_string(),
                balance: json_u128(e.get("balance")?)?,
                shares: json_u128(e.get("shares")?)?,
            })
        })
        .collect()
}

/// `null` (unregistered account) parses as empty positions.
pub fn parse_positions(v: &Value) -> Option<Positions> {
    if v.is_null() {
        return Some(Positions::default());
    }
    let regular = v.get("positions").and_then(|p| p.get("REGULAR"));
    Some(Positions {
        collateral: parse_entries(regular.and_then(|r| r.get("collateral")))?,
        borrowed: parse_entries(regular.and_then(|r| r.get("borrowed")))?,
        supplied: parse_entries(v.get("supplied"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_live_shapes() {
        let v: Value = serde_json::from_str(r#"{"account_id":"alice.test.near","positions":{"REGULAR":{"borrowed":[{"apr":"0.0","balance":"5000000000001460834","shares":"5000000000000000000","token_id":"usdc.near"}],"collateral":[{"apr":"0.0","balance":"10000000000000000000000000","shares":"10000000000000000000000000","token_id":"wrap.near"}]}},"supplied":[]}"#).unwrap();
        let p = parse_positions(&v).unwrap();
        assert_eq!(p.collateral[0].balance, 10u128.pow(25));
        assert_eq!(p.borrowed[0].shares, 5 * 10u128.pow(18));
        assert!(p.supplied.is_empty());
        assert!(parse_positions(&Value::Null).unwrap().borrowed.is_empty());

        let pr: Value = serde_json::from_str(r#"{"price":"534952557","conf":"264110","expo":-8,"publish_time":1792606342}"#).unwrap();
        let p = parse_price(&pr).unwrap();
        assert_eq!((p.price, p.conf, p.expo, p.publish_time), (534_952_557, 264_110, -8, 1_792_606_342));
        assert!(parse_price(&Value::Null).is_none());
    }
}

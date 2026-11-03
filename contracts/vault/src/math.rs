//! Pure math: prices, USD values, health factor, oracle-based min_out. No env calls except where noted.
use crate::types::Price;

uint::construct_uint! {
    /// 256-bit unsigned integer for intermediate products (balance × price can exceed u128).
    pub struct U256(4);
}

pub const BPS: u128 = 10_000;
/// USD values are fixed point with 18 decimals.
pub const USD_DECIMALS: u32 = 18;
pub const NS_PER_DAY: u64 = 86_400_000_000_000;
pub const HF_INFINITE: u64 = u64::MAX;

pub fn pow10(e: u32) -> U256 {
    U256::from(10u8).pow(U256::from(e))
}

pub fn day_index(timestamp_ns: u64) -> u64 {
    timestamp_ns / NS_PER_DAY
}

/// Checks a price is usable: positive, fresh, and with a tight enough confidence interval.
pub fn check_price(p: &Price, now_sec: i64, max_age_sec: u32, max_conf_bps: u16) -> Result<(), &'static str> {
    if p.price <= 0 {
        return Err("non_positive_price");
    }
    if p.publish_time > now_sec + 60 {
        return Err("price_from_future");
    }
    if now_sec.saturating_sub(p.publish_time) > max_age_sec as i64 {
        return Err("stale_price");
    }
    // conf / price <= max_conf_bps / 10000
    if (p.conf as u128) * BPS > (p.price as u128) * (max_conf_bps as u128) {
        return Err("wide_confidence");
    }
    Ok(())
}

/// USD value (18 decimals) of `amount` expressed with `decimals` decimals.
pub fn usd_value(amount: u128, decimals: u32, p: &Price) -> U256 {
    let num = U256::from(amount) * U256::from(p.price as u128);
    let scale = USD_DECIMALS as i64 + p.expo as i64; // multiply by 10^scale, then divide by 10^decimals
    if scale >= 0 {
        num * pow10(scale as u32) / pow10(decimals)
    } else {
        num / (pow10(decimals) * pow10((-scale) as u32))
    }
}

/// One side of a lending position, already valued.
pub struct Leg {
    pub value_usd: U256,
    pub volatility_ratio_bps: u32,
}

/// Health factor in bps, Burrow formula:
/// HF = Σ collateral_value × vol / Σ (debt_value / vol)
pub fn health_factor_bps(collateral: &[Leg], debt: &[Leg]) -> (u64, U256, U256) {
    let mut adj_coll = U256::zero();
    let mut coll = U256::zero();
    for l in collateral {
        coll += l.value_usd;
        adj_coll += l.value_usd * U256::from(l.volatility_ratio_bps) / U256::from(BPS);
    }
    let mut adj_debt = U256::zero();
    let mut debt_total = U256::zero();
    for l in debt {
        debt_total += l.value_usd;
        let vol = l.volatility_ratio_bps.max(1);
        adj_debt += l.value_usd * U256::from(BPS) / U256::from(vol);
    }
    if adj_debt.is_zero() {
        return (HF_INFINITE, coll, debt_total);
    }
    let hf = adj_coll * U256::from(BPS) / adj_debt;
    let hf = if hf > U256::from(u64::MAX - 1) { u64::MAX - 1 } else { hf.as_u64() };
    (hf, coll, debt_total)
}

/// Minimum acceptable output for swapping `amount_in` of token A into token B, from oracle prices,
/// after applying `slippage_bps`. Rounded down.
pub fn min_out(
    amount_in: u128,
    dec_in: u32,
    p_in: &Price,
    dec_out: u32,
    p_out: &Price,
    slippage_bps: u16,
) -> u128 {
    // out = amount_in × p_in × 10^expo_in / 10^dec_in × 10^dec_out / (p_out × 10^expo_out)
    let mut num = U256::from(amount_in) * U256::from(p_in.price as u128) * pow10(dec_out);
    let mut den = U256::from(p_out.price as u128) * pow10(dec_in);
    let e = p_in.expo as i64 - p_out.expo as i64;
    if e >= 0 {
        num *= pow10(e as u32);
    } else {
        den *= pow10((-e) as u32);
    }
    let fair = num / den;
    let out = fair * U256::from(BPS - slippage_bps as u128) / U256::from(BPS);
    if out > U256::from(u128::MAX) { u128::MAX } else { out.as_u128() }
}

pub fn to_u128(v: U256) -> u128 {
    if v > U256::from(u128::MAX) { u128::MAX } else { v.as_u128() }
}

/// Parses "ed25519:<base58 32 bytes>".
pub fn parse_ed25519_pubkey(s: &str) -> Result<[u8; 32], &'static str> {
    let b58 = s.strip_prefix("ed25519:").ok_or("expected ed25519: prefix")?;
    let bytes = bs58::decode(b58).into_vec().map_err(|_| "bad base58")?;
    bytes.try_into().map_err(|_| "expected 32 bytes")
}

/// Parses "ed25519:<base58 64 bytes>".
pub fn parse_ed25519_signature(s: &str) -> Result<[u8; 64], &'static str> {
    let b58 = s.strip_prefix("ed25519:").ok_or("expected ed25519: prefix")?;
    let bytes = bs58::decode(b58).into_vec().map_err(|_| "bad base58")?;
    bytes.try_into().map_err(|_| "expected 64 bytes")
}

pub fn base58(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(price: i64, expo: i32) -> Price {
        Price { price, conf: 0, expo, publish_time: 1_000 }
    }

    #[test]
    fn price_checks() {
        let p = Price { price: 500_000_000, conf: 100_000, expo: -8, publish_time: 1_000 };
        assert!(check_price(&p, 1_030, 60, 100).is_ok());
        assert_eq!(check_price(&p, 1_061, 60, 100), Err("stale_price"));
        let wide = Price { conf: 10_000_000, ..p.clone() }; // 2% of price
        assert_eq!(check_price(&wide, 1_000, 60, 100), Err("wide_confidence"));
        let neg = Price { price: 0, ..p.clone() };
        assert_eq!(check_price(&neg, 1_000, 60, 100), Err("non_positive_price"));
    }

    #[test]
    fn usd_value_wnear_and_usdc() {
        // 10 wNEAR (24 dec) at $5.00 (500000000e-8) = $50
        let v = usd_value(10 * 10u128.pow(24), 24, &px(500_000_000, -8));
        assert_eq!(v, U256::from(50u128) * pow10(18));
        // 5 USDC in Burrow inner units (6 + 12 = 18 dec) at $1.00
        let v = usd_value(5 * 10u128.pow(18), 18, &px(100_000_000, -8));
        assert_eq!(v, U256::from(5u128) * pow10(18));
    }

    #[test]
    fn health_factor_matches_burrow_formula() {
        let usd = |x: u128| U256::from(x) * pow10(18);
        // $50 wNEAR collateral (vol 0.75), $5 USDC debt (vol 0.95): HF = 37.5 / (5/0.95) = 7.125
        let (hf, coll, debt) = health_factor_bps(
            &[Leg { value_usd: usd(50), volatility_ratio_bps: 7_500 }],
            &[Leg { value_usd: usd(5), volatility_ratio_bps: 9_500 }],
        );
        assert_eq!(hf, 71_250);
        assert_eq!(coll, usd(50));
        assert_eq!(debt, usd(5));
        // no debt → infinite
        let (hf, _, _) = health_factor_bps(&[Leg { value_usd: usd(50), volatility_ratio_bps: 7_500 }], &[]);
        assert_eq!(hf, HF_INFINITE);
        // 1.8x leverage example: $90 coll (incl. looped), $40 debt → 67.5 / 42.105 = 1.603
        let (hf, _, _) = health_factor_bps(
            &[Leg { value_usd: usd(90), volatility_ratio_bps: 7_500 }],
            &[Leg { value_usd: usd(40), volatility_ratio_bps: 9_500 }],
        );
        assert_eq!(hf, 16_031);
    }

    #[test]
    fn min_out_wnear_to_usdc() {
        // 1 wNEAR at $5.00 → USDC at $1.00 with 1% slippage → 4.95 USDC (6 dec)
        let out = min_out(10u128.pow(24), 24, &px(500_000_000, -8), 6, &px(100_000_000, -8), 100);
        assert_eq!(out, 4_950_000);
        // reverse: 5 USDC → wNEAR, 1% → 0.99 wNEAR
        let out = min_out(5_000_000, 6, &px(100_000_000, -8), 24, &px(500_000_000, -8), 100);
        assert_eq!(out, 99 * 10u128.pow(22));
        // different exponents: USDC price with expo -6 (1000000) same result
        let out = min_out(10u128.pow(24), 24, &px(500_000_000, -8), 6, &px(1_000_000, -6), 100);
        assert_eq!(out, 4_950_000);
    }

    #[test]
    fn ed25519_parsing() {
        let pk = parse_ed25519_pubkey("ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc").unwrap();
        assert_eq!(pk.len(), 32);
        assert!(parse_ed25519_pubkey("reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc").is_err());
    }
}

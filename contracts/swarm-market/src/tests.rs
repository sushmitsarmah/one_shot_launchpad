//! Unit tests, named after the RULES.md rule they check.
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;
const UNIT: u128 = 1_000_000_000_000_000_000; // 18 decimals

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("yeetpad-swarm.testnet")
}
fn token() -> AccountId {
    acc("swrma.ft-factory.testnet")
}

/// Sets the VM context: caller, attached deposit (yocto) and block time (ms).
fn ctx(caller: &AccountId, deposit: u128, now_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("market.yeetpad-swarm.testnet"))
        .predecessor_account_id(caller.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ms * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

/// Round 0 opened at t=1000 ms with 10 s phases: list [1000,11000) commit [11000,21000) reveal [21000,31000).
fn setup() -> Market {
    ctx(&owner(), 0, 1000);
    let mut m = Market::new(owner());
    assert_eq!(m.open_round(10, 10, 10), 0);
    m
}

fn list(m: &mut Market, seller: &str, tok: &AccountId, qty: u128, reserve: u128) {
    ctx(tok, 0, 2000);
    let msg = json!({ "round": 0, "unit": U128(UNIT), "reserve": U128(reserve) }).to_string();
    let _ = m.ft_on_transfer(acc(seller), U128(qty * UNIT), msg);
}

fn h(lot: u32, bidder: &str, qty: u64, price: u128, salt: &str) -> String {
    commit_hash(0, lot, &acc(bidder), qty, price, salt)
}

fn commit(m: &mut Market, bidder: &str, lot: u32, qty: u64, price: u128, deposit: u128) {
    ctx(&acc(bidder), deposit, 12_000);
    m.commit(0, lot, h(lot, bidder, qty, price, "s"));
}

fn reveal(m: &mut Market, bidder: &str, lot: u32, qty: u64, price: u128) {
    ctx(&acc(bidder), 0, 22_000);
    m.reveal(0, lot, qty, U128(price), "s".into());
}

fn round(m: &Market) -> Round {
    m.get_round(0).unwrap().round
}

#[test]
fn r2_phases_follow_block_time() {
    let m = setup();
    for (t, p) in [(1000, Phase::Listing), (11_000, Phase::Commit), (21_000, Phase::Reveal), (31_000, Phase::Clearing)] {
        ctx(&owner(), 0, t);
        assert_eq!(m.get_round(0).unwrap().phase, p, "at {t}");
    }
}

#[test]
#[should_panic(expected = "previous round is not cleared yet")]
fn r2_1_one_round_at_a_time() {
    let mut m = setup();
    m.open_round(10, 10, 10);
}

#[test]
#[should_panic(expected = "each phase must last 5 s to 1 day")]
fn r2_2_phase_bounds() {
    ctx(&owner(), 0, 1000);
    let mut m = Market::new(owner());
    m.open_round(1, 10, 10);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_owner_opens_rounds() {
    ctx(&owner(), 0, 1000);
    let mut m = Market::new(owner());
    ctx(&acc("buyer-1.yeetpad-swarm.testnet"), 0, 1000);
    m.open_round(10, 10, 10);
}

#[test]
fn r3_listing_creates_lot() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 1000, 10 * MILLI / 1000);
    let r = round(&m);
    assert_eq!(r.lots.len(), 1);
    assert_eq!(r.lots[0].quantity, 1000);
    assert_eq!(r.lots[0].token, token());
    assert_eq!(r.lots[0].seller, acc("seller-1.t"));
}

#[test]
#[should_panic(expected = "not in the Listing phase")]
fn r3_1_listing_only_in_listing_phase() {
    let mut m = setup();
    ctx(&token(), 0, 11_000);
    let _ = m.ft_on_transfer(acc("seller-1.t"), U128(UNIT), json!({"round":0,"unit":U128(UNIT),"reserve":"1"}).to_string());
}

#[test]
#[should_panic(expected = "whole number of units")]
fn r3_2_whole_units_only() {
    let mut m = setup();
    ctx(&token(), 0, 2000);
    let _ = m.ft_on_transfer(acc("seller-1.t"), U128(UNIT + 1), json!({"round":0,"unit":U128(UNIT),"reserve":"1"}).to_string());
}

#[test]
#[should_panic(expected = "one lot per seller and token per round")]
fn r3_3_one_lot_per_seller_token() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 10, 1);
    list(&mut m, "seller-1.t", &token(), 10, 1);
}

#[test]
#[should_panic(expected = "not in the Commit phase")]
fn r4_1_commit_only_in_commit_phase() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 10, 1);
    ctx(&acc("b1"), MIN_DEPOSIT, 5000);
    m.commit(0, 0, h(0, "b1", 1, 1, "s"));
}

#[test]
#[should_panic(expected = "attach at least 0.005 NEAR")]
fn r4_1_min_deposit() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 10, 1);
    commit(&mut m, "b1", 0, 1, 1, MIN_DEPOSIT - 1);
}

#[test]
#[should_panic(expected = "already committed to this lot")]
fn r4_1_one_commit_per_lot() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 10, 1);
    commit(&mut m, "b1", 0, 1, 1, MIN_DEPOSIT);
    commit(&mut m, "b1", 0, 2, 1, MIN_DEPOSIT);
}

#[test]
#[should_panic(expected = "hash mismatch")]
fn r4_2_hash_binds_bidder() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 10, 1);
    // b2 copies b1's hash; b2 can't reveal it with b1's values.
    ctx(&acc("b2"), MIN_DEPOSIT, 12_000);
    m.commit(0, 0, h(0, "b1", 1, 1, "s"));
    reveal(&mut m, "b2", 0, 1, 1);
}

#[test]
#[should_panic(expected = "hash mismatch")]
fn r4_4_reveal_must_match() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 10, 1);
    commit(&mut m, "b1", 0, 5, 100, MIN_DEPOSIT);
    reveal(&mut m, "b1", 0, 5, 101);
}

#[test]
fn r4_5_unpayable_reveal_is_invalid_and_refunded() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 10, 1);
    commit(&mut m, "b1", 0, 10, MILLI, 6 * MILLI); // needs 10 + 1.25 milliNEAR
    reveal(&mut m, "b1", 0, 10, MILLI);
    assert_eq!(round(&m).bids[0].outcome, Outcome::Invalid);
    ctx(&acc("anyone"), 0, 31_000);
    m.clear(0);
    let r = round(&m);
    assert_eq!(r.bids[0].refund.0, 6 * MILLI);
    assert_eq!(r.lots[0].status, LotStatus::NoSale);
}

#[test]
fn r4_6_no_reveal_penalty_goes_to_seller() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 10, 1);
    commit(&mut m, "b1", 0, 1, 1, 10 * MILLI);
    ctx(&acc("anyone"), 0, 31_000);
    m.clear(0);
    let r = round(&m);
    assert_eq!(r.bids[0].outcome, Outcome::Unrevealed);
    assert_eq!(r.bids[0].refund.0, 9 * MILLI);
    assert_eq!(r.lots[0].penalties.0, MILLI);
}

#[test]
fn r5_clear_lot_uniform_price_partial_fill_and_ties() {
    // 100 units; bids (idx, qty, price)
    let bids = [(0, 60, 5), (1, 30, 7), (2, 30, 5), (3, 50, 3)];
    let (fills, p) = clear_lot(100, &bids);
    // 7 first (30), then the two 5s by commit order: idx0 60, idx2 gets the last 10.
    assert_eq!(fills, vec![(1, 30), (0, 60), (2, 10)]);
    assert_eq!(p, 5);
    // undersubscribed: everyone filled, price = lowest bid
    let (fills, p) = clear_lot(1000, &bids);
    assert_eq!(fills.len(), 4);
    assert_eq!(p, 3);
    assert_eq!(clear_lot(10, &[]), (vec![], 0));
}

#[test]
fn r5_full_round_settles_amounts() {
    let mut m = setup();
    let reserve = MILLI / 100; // 0.00001 NEAR per token
    list(&mut m, "seller-1.t", &token(), 100, reserve);
    // b1: 60 @ 0.05 mN, b2: 30 @ 0.07 mN, b3: 30 @ 0.05 mN, b4: 50 @ 0.005 mN (< reserve), b5 never reveals
    let p5 = MILLI / 20;
    let p7 = MILLI * 7 / 100;
    let dep = 10 * MILLI;
    commit(&mut m, "b1", 0, 60, p5, dep);
    commit(&mut m, "b2", 0, 30, p7, dep);
    commit(&mut m, "b3", 0, 30, p5, dep);
    commit(&mut m, "b4", 0, 50, reserve / 2, dep);
    commit(&mut m, "b5", 0, 50, p7, dep);
    reveal(&mut m, "b1", 0, 60, p5);
    reveal(&mut m, "b2", 0, 30, p7);
    reveal(&mut m, "b3", 0, 30, p5);
    reveal(&mut m, "b4", 0, 50, reserve / 2);
    ctx(&acc("anyone"), 0, 31_000);
    let lots = m.clear(0);
    assert_eq!(lots[0].sold, 100);
    assert_eq!(lots[0].clearing_price.0, p5); // R5.4
    let r = round(&m);
    let b = |i: usize| r.bids[i].clone();
    assert_eq!((b(0).filled, b(1).filled, b(2).filled), (60, 30, 10));
    assert_eq!(b(1).paid.0, 30 * p5); // pays clearing price, not its own bid
    assert_eq!(b(1).refund.0, dep - 30 * p5 - TOKEN_STORAGE);
    assert_eq!(b(3).outcome, Outcome::Lost); // R5.1 below reserve
    assert_eq!(b(3).refund.0, dep);
    assert_eq!(b(4).outcome, Outcome::Unrevealed);
    assert_eq!(lots[0].proceeds.0, 100 * p5); // R6.2
    assert_eq!(lots[0].penalties.0, dep / 10);
    for i in 0..3 {
        assert_eq!(b(i).delivery, Delivery::Pending);
    }
    // conservation: deposits = refunds + proceeds + penalties + fees
    let deposits: u128 = r.bids.iter().map(|b| b.deposit.0).sum();
    let out: u128 = r.bids.iter().map(|b| b.refund.0 + b.fee.0).sum::<u128>() + lots[0].proceeds.0 + lots[0].penalties.0;
    assert_eq!(deposits, out);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"round_cleared\"")));
}

#[test]
fn r5_6_no_bids_no_sale_returns_tokens() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 100, 1);
    ctx(&acc("anyone"), 0, 31_000);
    let lots = m.clear(0);
    assert_eq!(lots[0].status, LotStatus::NoSale);
    assert_eq!(lots[0].sold, 0);
}

#[test]
#[should_panic(expected = "not ready to clear")]
fn r6_clear_only_after_reveal_end() {
    let mut m = setup();
    ctx(&acc("anyone"), 0, 30_999);
    m.clear(0);
}

#[test]
#[should_panic(expected = "not ready to clear")]
fn r6_clear_once() {
    let mut m = setup();
    ctx(&acc("anyone"), 0, 31_000);
    m.clear(0);
    m.clear(0);
}

#[test]
fn r6_4_deliver_paginates_and_marks_in_flight() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 100, 1);
    for i in 0..10 {
        commit(&mut m, &format!("b{i}"), 0, 5, 10, MIN_DEPOSIT);
    }
    for i in 0..10 {
        reveal(&mut m, &format!("b{i}"), 0, 5, 10);
    }
    ctx(&acc("anyone"), 0, 31_000);
    m.clear(0);
    for want in [6, 4, 0] {
        ctx(&acc("anyone"), 0, 32_000);
        assert_eq!(m.deliver(0, 0, Some(6)), want);
    }
    assert!(round(&m).bids.iter().all(|b| b.delivery == Delivery::InFlight));
}

#[test]
fn r6_5_failed_delivery_is_retryable() {
    let mut m = setup();
    list(&mut m, "seller-1.t", &token(), 100, 1);
    commit(&mut m, "b1", 0, 5, 10, MIN_DEPOSIT);
    reveal(&mut m, "b1", 0, 5, 10);
    ctx(&acc("anyone"), 0, 31_000);
    m.clear(0);
    m.deliver(0, 0, None);
    ctx(&acc("market.yeetpad-swarm.testnet"), 0, 32_000);
    m.on_delivered(0, 0, Err(PromiseError::Failed));
    assert_eq!(round(&m).bids[0].delivery, Delivery::Failed);
    ctx(&acc("anyone"), 0, 33_000);
    assert_eq!(m.deliver(0, 0, None), 1);
    ctx(&acc("market.yeetpad-swarm.testnet"), 0, 34_000);
    m.on_delivered(0, 0, Ok(()));
    assert_eq!(round(&m).bids[0].delivery, Delivery::Delivered);
}

#[test]
#[should_panic(expected = "owner only")]
fn r7_2_only_owner_annotates() {
    let mut m = setup();
    ctx(&acc("b1"), 0, 2000);
    m.annotate(0, vec![]);
}

#[test]
fn commit_hash_matches_known_vector() {
    // Same vector is checked by the TypeScript engine (scripts/swarm/engine.test.ts).
    ctx(&owner(), 0, 0);
    assert_eq!(
        commit_hash(3, 1, &acc("buyer-7.yeetpad-swarm.testnet"), 120, 25_000_000_000_000_000_000, "abc"),
        hex(&env::sha256(b"3:1:buyer-7.yeetpad-swarm.testnet:120:25000000000000000000:abc"))
    );
}

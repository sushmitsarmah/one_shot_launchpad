//! Yeetpad Swarm Market: the coordinator contract for the "Many agents, one economy" track.
//!
//! Seller agents list lots of Yeetpad tokens (`ft_transfer_call`), buyer agents commit sealed bids
//! (`commit` with NEAR escrow) and reveal them (`reveal`). After the reveal deadline anyone can
//! `clear` a round (uniform-price, multi-unit clearing per lot; NEAR refunds and seller proceeds go
//! out in the same call) and `deliver` the tokens to the winners. Phases are set by block time, so
//! not even the owner can cut a phase short. The full rules are in RULES.md at the repo root; tests
//! are named after the rule they check (`r5_4_...`).
//!
//! Events: NEP-297 `EVENT_JSON` logs, standard `yeetpad_swarm`: `round_open`, `lot_listed`,
//! `commit`, `reveal`, `lot_cleared`, `round_cleared`, `delivered`, `delivery_failed`.
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::store::Vector;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use std::collections::BTreeMap;

const EVENT_STANDARD: &str = "yeetpad_swarm";
const EVENT_VERSION: &str = "1.0.0";
/// R4.1 minimum escrow per commit.
pub const MIN_DEPOSIT: u128 = 5_000_000_000_000_000_000_000; // 0.005 NEAR
/// R5.5 NEP-145 registration fee on the lot's token, paid by each winner.
pub const TOKEN_STORAGE: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR
/// R4.6 no-reveal penalty (basis points of the deposit), paid to the lot's seller.
pub const NO_REVEAL_PENALTY_BPS: u128 = 1_000;
pub const MAX_LOTS: usize = 10;
pub const MAX_BIDS: usize = 100;
pub const MAX_NOTES: usize = 400;
pub const MIN_PHASE_SECS: u64 = 5;
pub const MAX_PHASE_SECS: u64 = 86_400;
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(5);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(6);
const GAS_ON_DELIVERED: Gas = Gas::from_tgas(5);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Rounds,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Listing,
    Commit,
    Reveal,
    Clearing,
    Cleared,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LotStatus {
    Open,
    Cleared,
    NoSale,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Pending,
    Won,
    Lost,
    Invalid,
    Unrevealed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    None,
    Pending,
    InFlight,
    Delivered,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Lot {
    pub seller: AccountId,
    pub token: AccountId,
    /// Whole tokens on offer.
    pub quantity: u64,
    /// Base units per whole token (10^decimals).
    pub unit: U128,
    /// Minimum yoctoNEAR per whole token.
    pub reserve: U128,
    pub status: LotStatus,
    pub sold: u64,
    pub clearing_price: U128,
    pub proceeds: U128,
    pub penalties: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Bid {
    pub bidder: AccountId,
    pub lot: u32,
    pub hash: String,
    pub deposit: U128,
    pub committed_at_ms: u64,
    pub revealed: bool,
    pub qty: u64,
    pub price: U128,
    pub outcome: Outcome,
    pub filled: u64,
    pub paid: U128,
    pub fee: U128,
    pub refund: U128,
    pub delivery: Delivery,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct TxNote {
    /// e.g. "open", "list", "commit", "reveal", "clear", "deliver".
    pub kind: String,
    pub hash: String,
    pub account: Option<AccountId>,
    pub lot: Option<u32>,
    pub bid: Option<u32>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Round {
    pub id: u32,
    pub opened_at_ms: u64,
    pub list_end_ms: u64,
    pub commit_end_ms: u64,
    pub reveal_end_ms: u64,
    pub cleared_at_ms: u64,
    pub cleared: bool,
    pub lots: Vec<Lot>,
    pub bids: Vec<Bid>,
    pub notes: Vec<TxNote>,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RoundView {
    #[serde(flatten)]
    pub round: Round,
    pub phase: Phase,
    pub now_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ListMsg {
    pub round: u32,
    pub unit: U128,
    pub reserve: U128,
}

/// R5.1–R5.4 for one lot. `bids` are `(index, qty, price)` of eligible bids (revealed, valid,
/// price ≥ reserve), in commit order. Returns `(fills as (index, filled), clearing_price)`.
pub fn clear_lot(quantity: u64, bids: &[(usize, u64, u128)]) -> (Vec<(usize, u64)>, u128) {
    let mut order: Vec<&(usize, u64, u128)> = bids.iter().collect();
    // R5.2 highest price first; ties: earlier commit (lower index) first.
    order.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    let mut left = quantity;
    let mut fills = Vec::new();
    let mut clearing = 0u128;
    for (i, q, p) in order {
        if left == 0 {
            break;
        }
        let f = (*q).min(left);
        if f == 0 {
            continue;
        }
        left -= f;
        fills.push((*i, f));
        clearing = *p; // R5.4 lowest filled bid's price
    }
    (fills, clearing)
}

pub fn commit_hash(round: u32, lot: u32, bidder: &AccountId, qty: u64, price: u128, salt: &str) -> String {
    let pre = format!("{round}:{lot}:{bidder}:{qty}:{price}:{salt}");
    hex(&env::sha256(pre.as_bytes()))
}

fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })
    ));
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn phase_of(r: &Round, now: u64) -> Phase {
    if r.cleared {
        Phase::Cleared
    } else if now < r.list_end_ms {
        Phase::Listing
    } else if now < r.commit_end_ms {
        Phase::Commit
    } else if now < r.reveal_end_ms {
        Phase::Reveal
    } else {
        Phase::Clearing
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    owner: AccountId,
    rounds: Vector<Round>,
}

#[near]
impl Market {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self { owner: owner_id, rounds: Vector::new(StorageKey::Rounds) }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn round_mut(&mut self, round: u32) -> &mut Round {
        self.rounds.get_mut(round).unwrap_or_else(|| env::panic_str("no such round"))
    }

    // ---------- owner ----------

    /// Opens a new round. R2.1 the previous round must be cleared; R2.2 phase lengths 5 s–1 day.
    pub fn open_round(&mut self, list_secs: u64, commit_secs: u64, reveal_secs: u64) -> u32 {
        self.assert_owner();
        for s in [list_secs, commit_secs, reveal_secs] {
            require!((MIN_PHASE_SECS..=MAX_PHASE_SECS).contains(&s), "each phase must last 5 s to 1 day");
        }
        if let Some(last) = self.rounds.len().checked_sub(1).and_then(|i| self.rounds.get(i)) {
            require!(last.cleared, "previous round is not cleared yet");
        }
        let t0 = now_ms();
        let id = self.rounds.len();
        let list_end_ms = t0 + list_secs * 1000;
        let commit_end_ms = list_end_ms + commit_secs * 1000;
        let reveal_end_ms = commit_end_ms + reveal_secs * 1000;
        self.rounds.push(Round {
            id,
            opened_at_ms: t0,
            list_end_ms,
            commit_end_ms,
            reveal_end_ms,
            cleared_at_ms: 0,
            cleared: false,
            lots: vec![],
            bids: vec![],
            notes: vec![],
        });
        emit("round_open", json!({ "round": id, "list_end_ms": list_end_ms, "commit_end_ms": commit_end_ms, "reveal_end_ms": reveal_end_ms }));
        id
    }

    /// R7.2 attach transaction hashes for the public page. Cannot change any amount or outcome.
    pub fn annotate(&mut self, round: u32, notes: Vec<TxNote>) {
        self.assert_owner();
        let r = self.round_mut(round);
        require!(r.notes.len() + notes.len() <= MAX_NOTES, "too many notes");
        for n in &notes {
            require!(n.kind.len() <= 16 && n.hash.len() <= 64, "note too long");
        }
        r.notes.extend(notes);
    }

    pub fn set_owner(&mut self, owner_id: AccountId) {
        self.assert_owner();
        self.owner = owner_id;
    }

    // ---------- sellers ----------

    /// NEP-141 receiver: lists a lot (R3). Panicking makes the token refund the seller (R3.4).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let m: ListMsg = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("msg must be {\"round\":n,\"unit\":\"..\",\"reserve\":\"..\"}"));
        let now = now_ms();
        let r = self.round_mut(m.round);
        require!(phase_of(r, now) == Phase::Listing, "round is not in the Listing phase");
        require!(m.unit.0 > 0, "unit must be > 0");
        require!(amount.0 % m.unit.0 == 0, "amount must be a whole number of units");
        let q = amount.0 / m.unit.0;
        require!(q >= 1 && q <= u64::MAX as u128, "quantity out of range");
        require!(r.lots.len() < MAX_LOTS, "round is full");
        require!(
            !r.lots.iter().any(|l| l.seller == sender_id && l.token == token),
            "one lot per seller and token per round"
        );
        let lot = r.lots.len() as u32;
        r.lots.push(Lot {
            seller: sender_id.clone(),
            token: token.clone(),
            quantity: q as u64,
            unit: m.unit,
            reserve: m.reserve,
            status: LotStatus::Open,
            sold: 0,
            clearing_price: U128(0),
            proceeds: U128(0),
            penalties: U128(0),
        });
        emit("lot_listed", json!({ "round": m.round, "lot": lot, "seller": sender_id, "token": token, "quantity": q.to_string(), "reserve": m.reserve }));
        PromiseOrValue::Value(U128(0))
    }

    // ---------- buyers ----------

    /// R4.1 sealed bid with NEAR escrow.
    #[payable]
    pub fn commit(&mut self, round: u32, lot: u32, hash: String) {
        let bidder = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let now = now_ms();
        let r = self.round_mut(round);
        require!(phase_of(r, now) == Phase::Commit, "round is not in the Commit phase");
        require!((lot as usize) < r.lots.len(), "no such lot");
        require!(hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "hash must be 64 lowercase hex chars");
        require!(deposit >= MIN_DEPOSIT, "attach at least 0.005 NEAR");
        require!(!r.bids.iter().any(|b| b.bidder == bidder && b.lot == lot), "already committed to this lot");
        require!(r.bids.len() < MAX_BIDS, "round has too many bids");
        let idx = r.bids.len();
        r.bids.push(Bid {
            bidder: bidder.clone(),
            lot,
            hash: hash.clone(),
            deposit: U128(deposit),
            committed_at_ms: now,
            revealed: false,
            qty: 0,
            price: U128(0),
            outcome: Outcome::Pending,
            filled: 0,
            paid: U128(0),
            fee: U128(0),
            refund: U128(0),
            delivery: Delivery::None,
        });
        emit("commit", json!({ "round": round, "lot": lot, "bid": idx, "bidder": bidder, "hash": hash, "deposit": U128(deposit) }));
    }

    /// R4.4 / R4.5 reveal a sealed bid.
    pub fn reveal(&mut self, round: u32, lot: u32, qty: u64, price: U128, salt: String) {
        let bidder = env::predecessor_account_id();
        require!(salt.len() <= 128, "salt too long");
        let now = now_ms();
        let r = self.round_mut(round);
        require!(phase_of(r, now) == Phase::Reveal, "round is not in the Reveal phase");
        let idx = r
            .bids
            .iter()
            .position(|b| b.bidder == bidder && b.lot == lot)
            .unwrap_or_else(|| env::panic_str("no commit for this lot"));
        let b = &mut r.bids[idx];
        require!(!b.revealed, "already revealed");
        require!(commit_hash(round, lot, &bidder, qty, price.0, &salt) == b.hash, "hash mismatch");
        b.revealed = true;
        b.qty = qty;
        b.price = price;
        let cost = (qty as u128).checked_mul(price.0).and_then(|c| c.checked_add(TOKEN_STORAGE));
        let valid = qty > 0 && cost.map_or(false, |c| c <= b.deposit.0);
        if !valid {
            b.outcome = Outcome::Invalid;
        }
        emit("reveal", json!({ "round": round, "lot": lot, "bid": idx, "bidder": bidder, "qty": qty.to_string(), "price": price, "valid": valid }));
    }

    // ---------- clearing & settlement (anyone) ----------

    /// R5 + R6.1–R6.3. Callable by anyone once the reveal deadline has passed.
    pub fn clear(&mut self, round: u32) -> Vec<Lot> {
        let now = now_ms();
        let r = self.round_mut(round);
        require!(phase_of(r, now) == Phase::Clearing, "round is not ready to clear");
        let mut refunds: BTreeMap<AccountId, u128> = BTreeMap::new();
        let mut unsold: Vec<(AccountId, AccountId, u128)> = vec![];

        for li in 0..r.lots.len() {
            let (quantity, reserve) = (r.lots[li].quantity, r.lots[li].reserve.0);
            let eligible: Vec<(usize, u64, u128)> = r
                .bids
                .iter()
                .enumerate()
                .filter(|(_, b)| b.lot as usize == li && b.revealed && b.outcome != Outcome::Invalid && b.price.0 >= reserve)
                .map(|(i, b)| (i, b.qty, b.price.0))
                .collect();
            let (fills, clearing) = clear_lot(quantity, &eligible);
            let mut sold = 0u64;
            let mut proceeds = 0u128;
            let mut penalties = 0u128;
            for (i, f) in &fills {
                let b = &mut r.bids[*i];
                b.filled = *f;
                b.outcome = Outcome::Won;
                b.paid = U128(*f as u128 * clearing);
                b.fee = U128(TOKEN_STORAGE);
                b.delivery = Delivery::Pending;
                sold += f;
                proceeds += b.paid.0;
            }
            for b in r.bids.iter_mut().filter(|b| b.lot as usize == li) {
                match b.outcome {
                    Outcome::Won => b.refund = U128(b.deposit.0 - b.paid.0 - b.fee.0),
                    Outcome::Invalid => b.refund = b.deposit,
                    _ if !b.revealed => {
                        let pen = b.deposit.0 * NO_REVEAL_PENALTY_BPS / 10_000;
                        penalties += pen;
                        b.outcome = Outcome::Unrevealed;
                        b.refund = U128(b.deposit.0 - pen);
                    }
                    _ => {
                        b.outcome = Outcome::Lost;
                        b.refund = b.deposit;
                    }
                }
                *refunds.entry(b.bidder.clone()).or_default() += b.refund.0;
            }
            let l = &mut r.lots[li];
            l.sold = sold;
            l.clearing_price = U128(if sold > 0 { clearing } else { 0 });
            l.proceeds = U128(proceeds);
            l.penalties = U128(penalties);
            l.status = if sold > 0 { LotStatus::Cleared } else { LotStatus::NoSale };
            *refunds.entry(l.seller.clone()).or_default() += proceeds + penalties;
            if sold < quantity {
                unsold.push((l.token.clone(), l.seller.clone(), (quantity - sold) as u128 * l.unit.0));
            }
            emit("lot_cleared", json!({ "round": round, "lot": li, "sold": sold.to_string(), "clearing_price": U128(l.clearing_price.0), "proceeds": U128(proceeds), "penalties": U128(penalties) }));
        }
        r.cleared = true;
        r.cleared_at_ms = now;
        let lots = r.lots.clone();
        for (acct, amt) in refunds {
            if amt > 0 {
                Promise::new(acct).transfer(NearToken::from_yoctonear(amt)).detach();
            }
        }
        for (token, seller, amt) in unsold {
            Promise::new(token)
                .function_call(
                    "ft_transfer".to_string(),
                    json!({ "receiver_id": seller, "amount": U128(amt), "memo": "yeetpad swarm: unsold" }).to_string().into_bytes(),
                    ONE_YOCTO,
                    GAS_FT_TRANSFER,
                )
                .detach();
        }
        emit("round_cleared", json!({ "round": round }));
        lots
    }

    /// R6.4 / R6.5 push tokens to up to `limit` (default 5, max 6; ~35 Tgas each) winners of `lot`. Retries `Failed`.
    /// Returns how many deliveries were started.
    pub fn deliver(&mut self, round: u32, lot: u32, limit: Option<u32>) -> u32 {
        let limit = limit.unwrap_or(5).min(6) as usize;
        let me = env::current_account_id();
        let r = self.round_mut(round);
        require!(r.cleared, "round is not cleared");
        let l = r.lots.get(lot as usize).cloned().unwrap_or_else(|| env::panic_str("no such lot"));
        let mut started = 0u32;
        for (i, b) in r.bids.iter_mut().enumerate() {
            if started as usize >= limit {
                break;
            }
            if b.lot != lot || !matches!(b.delivery, Delivery::Pending | Delivery::Failed) {
                continue;
            }
            b.delivery = Delivery::InFlight;
            let amount = U128(b.filled as u128 * l.unit.0);
            Promise::new(l.token.clone())
                .function_call(
                    "storage_deposit".to_string(),
                    json!({ "account_id": b.bidder, "registration_only": true }).to_string().into_bytes(),
                    NearToken::from_yoctonear(TOKEN_STORAGE),
                    GAS_STORAGE_DEPOSIT,
                )
                .function_call(
                    "ft_transfer".to_string(),
                    json!({ "receiver_id": b.bidder, "amount": amount, "memo": format!("yeetpad swarm r{round} lot{lot}") })
                        .to_string()
                        .into_bytes(),
                    ONE_YOCTO,
                    GAS_FT_TRANSFER,
                )
                .then(Self::ext(me.clone()).with_static_gas(GAS_ON_DELIVERED).on_delivered(round, i as u32))
                .detach();
            started += 1;
        }
        started
    }

    #[private]
    pub fn on_delivered(&mut self, round: u32, bid: u32, #[callback_result] result: Result<(), PromiseError>) -> bool {
        let r = self.round_mut(round);
        let b = &mut r.bids[bid as usize];
        let ok = result.is_ok();
        b.delivery = if ok { Delivery::Delivered } else { Delivery::Failed };
        emit(
            if ok { "delivered" } else { "delivery_failed" },
            json!({ "round": round, "bid": bid, "bidder": b.bidder, "lot": b.lot, "filled": b.filled.to_string() }),
        );
        ok
    }

    // ---------- views ----------

    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({
            "owner": self.owner,
            "rounds": self.rounds.len(),
            "min_deposit": U128(MIN_DEPOSIT),
            "token_storage_fee": U128(TOKEN_STORAGE),
            "no_reveal_penalty_bps": NO_REVEAL_PENALTY_BPS as u64,
            "max_lots": MAX_LOTS,
            "max_bids": MAX_BIDS,
            "hash_format": "hex(sha256(\"{round}:{lot}:{bidder}:{qty}:{price}:{salt}\"))",
        })
    }

    pub fn get_round_count(&self) -> u32 {
        self.rounds.len()
    }

    pub fn get_round(&self, round: u32) -> Option<RoundView> {
        let now = now_ms();
        self.rounds.get(round).map(|r| RoundView { phase: phase_of(r, now), now_ms: now, round: r.clone() })
    }

    /// Newest first when `from` is omitted.
    pub fn get_rounds(&self, from: Option<u32>, limit: Option<u32>) -> Vec<RoundView> {
        let n = self.rounds.len();
        let limit = limit.unwrap_or(10).min(20);
        let now = now_ms();
        let ids: Vec<u32> = match from {
            Some(f) => (f..n).take(limit as usize).collect(),
            None => (0..n).rev().take(limit as usize).collect(),
        };
        ids.into_iter()
            .filter_map(|i| self.rounds.get(i).map(|r| RoundView { phase: phase_of(r, now), now_ms: now, round: r.clone() }))
            .collect()
    }

    pub fn get_commit_hash(&self, round: u32, lot: u32, bidder: AccountId, qty: u64, price: U128, salt: String) -> String {
        commit_hash(round, lot, &bidder, qty, price.0, &salt)
    }
}

#[cfg(test)]
mod tests;

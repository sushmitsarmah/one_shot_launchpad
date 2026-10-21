//! Yeetpad launch vault: users deposit NEAR as credits; authorized relayers charge AI compute and
//! execute sponsored token launches (single or batches of up to 5) via the factory. Every launch
//! is debited up front and refunded per item if the factory call fails.
//!
//! Events: NEP-297 `EVENT_JSON` logs, standard `yeetpad_vault`, events
//! `deposit`, `charge`, `launch_start`, `launch`, `refund`, `withdraw` (+ admin events).
//! Admin: relayers, fee, pause/unpause, two-step owner transfer, `update_contract` + `migrate`.
//!
//! Rhea listing (v0.3): a launch with `hold_for_listing` mints its supply to the vault, then
//! `list_on_rhea` creates a Rhea DCL pool `<token>|<wnear>|10000`, adds the pool share one-sided,
//! and hands everything to the creator: the LP position NFT (`nft_transfer`) and every remaining
//! token (creator share + dust). The vault keeps nothing. Events `listed` / `list_failed` /
//! `released`. If listing fails at any step, the full balance (and the position, if one was
//! made) goes to the creator; `release` retries that hand-off.
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

const EVENT_STANDARD: &str = "yeetpad_vault";
const EVENT_VERSION: &str = "1.0.0";
/// Static gas for one factory `create_token`; unused gas is shared between factory calls (weight 1).
const GAS_FOR_FACTORY: Gas = Gas::from_tgas(40);
const GAS_FOR_LAUNCH_CALLBACK: Gas = Gas::from_tgas(7);
const GAS_FOR_MIGRATE: Gas = Gas::from_tgas(50);
const MAX_FEE_BPS: u16 = 10_000;
/// Rhea DCL fee tier used for listings (1%) and its point spacing.
pub const DCL_FEE: u32 = 10_000;
pub const DCL_POINT_DELTA: i32 = 200;
pub const DCL_MAX_POINT: i32 = 800_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEP-145 registration on our token (and wNEAR-style tokens).
pub const TOKEN_STORAGE: u128 = 1_250_000_000_000_000_000_000;
/// Upper bounds on what a relayer may ask the vault to spend on one listing.
pub const MAX_POOL_DEPOSIT: u128 = 200_000_000_000_000_000_000_000; // 0.2 NEAR
pub const MAX_DCL_STORAGE: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR
const GAS_STORAGE: Gas = Gas::from_tgas(5);
const GAS_CREATE_POOL: Gas = Gas::from_tgas(15);
/// DCL's ft_on_transfer burnt >40 Tgas on a first deposit (testnet), so leave plenty.
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(90);
const GAS_NFT_TRANSFER: Gas = Gas::from_tgas(25);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_VIEW: Gas = Gas::from_tgas(5);
const GAS_VIEW_LIST: Gas = Gas::from_tgas(20);
const GAS_WITHDRAW_ASSET: Gas = Gas::from_tgas(40);
const GAS_ON_PREPARED: Gas = Gas::from_tgas(30);
const GAS_ON_LIQUIDITY: Gas = Gas::from_tgas(25);
const GAS_ON_BALANCE: Gas = Gas::from_tgas(15);
pub const MAX_BATCH: usize = 5;
pub const MIN_TICKER_LEN: usize = 2;
pub const MAX_TICKER_LEN: usize = 16;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Relayers,
    Balances,
    Held,
}

/// A launch whose supply sits in the vault until it is listed (or released) to its creator.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Held {
    pub creator: AccountId,
    pub ticker: String,
    /// Pool id once `create_pool` succeeded.
    pub pool_id: Option<String>,
    /// DCL position id while it is still owned by the vault (hand-off pending).
    pub lpt_id: Option<String>,
    /// True while a listing chain is running (blocks a second `list_on_rhea`).
    pub listing: bool,
}

/// One-sided DCL position parameters for `list_on_rhea` (computed off-chain, checked here).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ListParams {
    /// Token amount placed in the pool; the rest of the vault's balance goes to the creator.
    pub pool_amount: U128,
    /// Opening point (current price) of the new pool.
    pub init_point: i32,
    pub left_point: i32,
    pub right_point: i32,
    /// NEAR attached to `create_pool` (unused part is refunded by Rhea to the vault).
    pub pool_deposit: U128,
    /// NEAR for the creator's DCL storage (needed to own the position); 0 if already registered.
    pub creator_dcl_storage: U128,
    /// Optional top-up of the vault's own DCL storage (normally 0: the position slot is freed when
    /// it moves to the creator). Kept on the vault's DCL account.
    #[serde(default)]
    pub vault_dcl_topup: Option<U128>,
    /// The pool already exists (e.g. re-listing): only add liquidity. `init_point` must then be the
    /// pool's current point.
    #[serde(default)]
    pub skip_create_pool: Option<bool>,
}

/// Token parameters for a sponsored launch.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct TokenArgs {
    /// Lowercase ticker, becomes `<ticker>.<factory>`.
    pub ticker: String,
    pub name: String,
    /// Display symbol (defaults to upper-cased ticker).
    pub symbol: Option<String>,
    /// NEP-148 icon, e.g. a data:image/svg+xml URI.
    pub icon: Option<String>,
    pub decimals: Option<u8>,
    pub total_supply: U128,
    /// Optional site config JSON stored by the factory for the token page.
    pub site: Option<String>,
    /// Mint the supply to the vault so `list_on_rhea` can seed a Rhea pool (default false).
    #[serde(default)]
    pub hold_for_listing: Option<bool>,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct LaunchVault {
    owner_id: AccountId,
    authorized_relayers: IterableSet<AccountId>,
    user_balances: LookupMap<AccountId, u128>,
    platform_fee_bps: u16,
    treasury_balance: u128,
    ft_factory: AccountId,
    pending_owner: Option<AccountId>,
    paused: bool,
    dcl: AccountId,
    wnear: AccountId,
    held: LookupMap<AccountId, Held>,
}

/// v0.2 state, for `migrate`.
#[near(serializers = [borsh])]
pub struct LaunchVaultV2 {
    owner_id: AccountId,
    authorized_relayers: IterableSet<AccountId>,
    user_balances: LookupMap<AccountId, u128>,
    platform_fee_bps: u16,
    treasury_balance: u128,
    ft_factory: AccountId,
    pending_owner: Option<AccountId>,
    paused: bool,
}

/// v0.1 state, for `migrate`.
#[near(serializers = [borsh])]
pub struct LaunchVaultV1 {
    owner_id: AccountId,
    authorized_relayers: IterableSet<AccountId>,
    user_balances: LookupMap<AccountId, u128>,
    platform_fee_bps: u16,
    treasury_balance: u128,
    ft_factory: AccountId,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })
    ));
}

/// Same rules as the factory, checked up front so a bad batch fails before anything is debited.
pub fn validate_ticker(ticker: &str) {
    require!(
        (MIN_TICKER_LEN..=MAX_TICKER_LEN).contains(&ticker.len()),
        format!("ticker must be {MIN_TICKER_LEN}-{MAX_TICKER_LEN} chars")
    );
    require!(
        ticker.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
        "ticker must be lowercase a-z / 0-9"
    );
    require!(ticker.chars().next().unwrap().is_ascii_lowercase(), "ticker must start with a letter");
}

#[near]
impl LaunchVault {
    #[init]
    pub fn new(
        owner_id: AccountId,
        ft_factory: AccountId,
        platform_fee_bps: Option<u16>,
        relayers: Option<Vec<AccountId>>,
    ) -> Self {
        let fee = platform_fee_bps.unwrap_or(0);
        require!(fee <= MAX_FEE_BPS, "fee bps > 10000");
        let mut set = IterableSet::new(StorageKey::Relayers);
        for r in relayers.unwrap_or_default() {
            set.insert(r);
        }
        Self {
            owner_id,
            authorized_relayers: set,
            user_balances: LookupMap::new(StorageKey::Balances),
            platform_fee_bps: fee,
            treasury_balance: 0,
            ft_factory,
            pending_owner: None,
            paused: false,
            dcl: default_dcl(),
            wnear: default_wnear(),
            held: LookupMap::new(StorageKey::Held),
        }
    }

    /// Upgrade from the v0.1 / v0.2 layouts. Balances, relayers and treasury are kept.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        use near_sdk::borsh::BorshDeserialize;
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no state to migrate"));
        if let Ok(cur) = LaunchVault::try_from_slice(&raw) {
            return cur; // already on this layout
        }
        let (dcl, wnear, held) = (default_dcl(), default_wnear(), LookupMap::new(StorageKey::Held));
        if let Ok(o) = LaunchVaultV2::try_from_slice(&raw) {
            return Self {
                owner_id: o.owner_id,
                authorized_relayers: o.authorized_relayers,
                user_balances: o.user_balances,
                platform_fee_bps: o.platform_fee_bps,
                treasury_balance: o.treasury_balance,
                ft_factory: o.ft_factory,
                pending_owner: o.pending_owner,
                paused: o.paused,
                dcl,
                wnear,
                held,
            };
        }
        let o = LaunchVaultV1::try_from_slice(&raw).unwrap_or_else(|_| env::panic_str("unknown state layout"));
        Self {
            owner_id: o.owner_id,
            authorized_relayers: o.authorized_relayers,
            user_balances: o.user_balances,
            platform_fee_bps: o.platform_fee_bps,
            treasury_balance: o.treasury_balance,
            ft_factory: o.ft_factory,
            pending_owner: None,
            paused: false,
            dcl,
            wnear,
            held,
        }
    }

    // ---------- user ----------

    /// Credits the attached NEAR. A first deposit pays for its own balance entry's storage.
    #[payable]
    pub fn deposit_credits(&mut self) -> U128 {
        self.assert_not_paused();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit");
        let user = env::predecessor_account_id();
        let before = env::storage_usage();
        let had_entry = self.user_balances.contains_key(&user);
        // Write once with the gross amount to measure storage, then settle.
        let cur = self.balance_of(&user);
        self.user_balances.insert(user.clone(), cur.checked_add(amount).expect("overflow"));
        self.user_balances.flush();
        let storage_cost = if had_entry {
            0
        } else {
            env::storage_byte_cost().as_yoctonear() * (env::storage_usage().saturating_sub(before) as u128)
        };
        require!(amount > storage_cost, format!("deposit must exceed {storage_cost} yoctoNEAR storage"));
        let new_bal = cur + amount - storage_cost;
        self.user_balances.insert(user.clone(), new_bal);
        emit(
            "deposit",
            json!({ "account_id": user, "amount": U128(amount), "storage_cost": U128(storage_cost), "balance": U128(new_bal) }),
        );
        U128(new_bal)
    }

    /// Always allowed, even while paused.
    pub fn withdraw_unused(&mut self, amount: U128) -> Promise {
        require!(amount.0 > 0, "amount must be > 0");
        let user = env::predecessor_account_id();
        let left = self.debit(&user, amount.0);
        emit("withdraw", json!({ "account_id": user, "amount": amount, "balance": U128(left) }));
        Promise::new(user).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---------- relayer ----------

    pub fn deduct_ai_compute(&mut self, user_id: AccountId, amount: U128) -> U128 {
        self.assert_relayer();
        self.assert_not_paused();
        require!(amount.0 > 0, "amount must be > 0");
        let left = self.debit(&user_id, amount.0);
        self.treasury_balance = self.treasury_balance.checked_add(amount.0).expect("overflow");
        emit("charge", json!({ "account_id": user_id, "amount": amount, "reason": "ai_compute", "balance": U128(left) }));
        U128(left)
    }

    /// Debits `deposit_required` (+ platform fee) and asks the factory to create the token owned
    /// by `user_id`. Returns the token id, or `None` after refunding if the factory failed.
    pub fn execute_sponsored_launch(&mut self, user_id: AccountId, token: TokenArgs, deposit_required: U128) -> Promise {
        self.assert_relayer();
        self.assert_not_paused();
        self.check_batch(std::slice::from_ref(&token), deposit_required);
        let fee = self.fee_for(deposit_required.0);
        self.debit(&user_id, deposit_required.0.checked_add(fee).expect("overflow"));
        self.launch_one(&user_id, token, deposit_required, fee)
    }

    /// Up to `MAX_BATCH` launches in one call. The full cost is debited up front; each item has
    /// its own callback that books the fee on success or refunds that item's share on failure.
    /// Results are reported through `launch` / `refund` events (one per item). Returns the
    /// number of launches started.
    pub fn execute_sponsored_launch_batch(
        &mut self,
        user_id: AccountId,
        tokens: Vec<TokenArgs>,
        deposit_required: U128,
    ) -> u32 {
        self.assert_relayer();
        self.assert_not_paused();
        self.check_batch(&tokens, deposit_required);
        let fee = self.fee_for(deposit_required.0);
        let per_item = deposit_required.0.checked_add(fee).expect("overflow");
        let total = per_item.checked_mul(tokens.len() as u128).expect("overflow");
        self.debit(&user_id, total);
        let n = tokens.len() as u32;
        for t in tokens {
            self.launch_one(&user_id, t, deposit_required, fee).detach();
        }
        n
    }

    #[private]
    pub fn on_launch_complete(
        &mut self,
        user_id: AccountId,
        deposit: U128,
        fee: U128,
        ticker: String,
        hold: Option<bool>,
        #[callback_result] result: Result<Option<AccountId>, PromiseError>,
    ) -> Option<AccountId> {
        match result {
            Ok(Some(token_id)) => {
                self.treasury_balance = self.treasury_balance.checked_add(fee.0).expect("overflow");
                if hold == Some(true) {
                    self.held.insert(
                        token_id.clone(),
                        Held { creator: user_id.clone(), ticker: ticker.clone(), pool_id: None, lpt_id: None, listing: false },
                    );
                }
                emit(
                    "launch",
                    json!({ "account_id": user_id, "ticker": ticker, "token_id": token_id, "deposit": deposit, "fee": fee }),
                );
                Some(token_id)
            }
            _ => {
                // Factory panicked (deposit auto-refunded to the vault) or refunded it explicitly.
                let refund = deposit.0.checked_add(fee.0).expect("overflow");
                let bal = self.balance_of(&user_id).checked_add(refund).expect("overflow");
                self.user_balances.insert(user_id.clone(), bal);
                log!("launch of {} failed, refunded {}", ticker, refund);
                emit(
                    "refund",
                    json!({ "account_id": user_id, "ticker": ticker, "amount": U128(refund), "balance": U128(bal) }),
                );
                None
            }
        }
    }


    // ---------- Rhea listing ----------

    /// Relayer only. Lists a held launch on Rhea DCL: registers storage, creates the pool (unless
    /// `skip_create_pool`), adds `pool_amount` one-sided with a HotZap deposit and hands the position
    /// + all remaining tokens to the creator. Debits `listing_cost(params)` from the creator's credit.
    pub fn list_on_rhea(&mut self, user_id: AccountId, token_id: AccountId, params: ListParams) -> Promise {
        self.assert_relayer();
        self.assert_not_paused();
        let mut h = self.held.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("token is not held for listing"));
        require!(h.creator == user_id, "user is not the token's creator");
        require!(!h.listing, "listing already in progress");
        require!(h.lpt_id.is_none(), "position hand-off pending; use release");
        let token_is_x = token_id < self.wnear;
        check_points(token_is_x, params.init_point, params.left_point, params.right_point);
        require!(params.pool_amount.0 > 0, "pool_amount must be > 0");
        let skip = params.skip_create_pool == Some(true);
        require!(skip || (params.pool_deposit.0 > 0 && params.pool_deposit.0 <= MAX_POOL_DEPOSIT), "pool_deposit out of range");
        require!(params.creator_dcl_storage.0 <= MAX_DCL_STORAGE, "creator_dcl_storage out of range");
        require!(params.vault_dcl_topup.map(|v| v.0).unwrap_or(0) <= MAX_DCL_STORAGE, "vault_dcl_topup out of range");
        let cost = listing_cost(&params);
        self.debit(&user_id, cost);
        h.listing = true;
        h.pool_id = None;
        self.held.insert(token_id.clone(), h);
        emit("list_start", json!({ "account_id": user_id, "token_id": token_id, "cost": U128(cost) }));

        let (x, y) = if token_is_x { (token_id.clone(), self.wnear.clone()) } else { (self.wnear.clone(), token_id.clone()) };
        let mut joint = Promise::new(token_id.clone())
            .function_call("storage_deposit", json!({ "account_id": self.dcl, "registration_only": true }).to_string().into_bytes(), NearToken::from_yoctonear(TOKEN_STORAGE), GAS_STORAGE)
            .function_call("storage_deposit", json!({ "account_id": user_id, "registration_only": true }).to_string().into_bytes(), NearToken::from_yoctonear(TOKEN_STORAGE), GAS_STORAGE);
        // Result order seen by on_list_prepared follows prep_refunds(): regs, pool?, creator storage?, vault top-up?
        if !skip {
            joint = joint.and(Promise::new(self.dcl.clone()).function_call(
                "create_pool",
                json!({ "token_a": x, "token_b": y, "fee": DCL_FEE, "init_point": params.init_point }).to_string().into_bytes(),
                NearToken::from_yoctonear(params.pool_deposit.0),
                GAS_CREATE_POOL,
            ));
        }
        if params.creator_dcl_storage.0 > 0 {
            joint = joint.and(Promise::new(self.dcl.clone()).function_call(
                "storage_deposit",
                json!({ "account_id": user_id, "registration_only": false }).to_string().into_bytes(),
                NearToken::from_yoctonear(params.creator_dcl_storage.0),
                GAS_STORAGE,
            ));
        }
        let topup = params.vault_dcl_topup.map(|v| v.0).unwrap_or(0);
        if topup > 0 {
            joint = joint.and(Promise::new(self.dcl.clone()).function_call(
                "storage_deposit",
                json!({ "account_id": env::current_account_id(), "registration_only": false }).to_string().into_bytes(),
                NearToken::from_yoctonear(topup),
                GAS_STORAGE,
            ));
        }
        joint.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_PREPARED)
                .with_unused_gas_weight(1)
                .on_list_prepared(user_id, token_id, params),
        )
    }

    #[private]
    pub fn on_list_prepared(&mut self, user_id: AccountId, token_id: AccountId, params: ListParams) -> Promise {
        let refunds = prep_refunds(&params);
        let mut ok = true;
        for (i, back) in refunds.iter().enumerate() {
            if env::promise_result_checked(i as u64, 1024).is_err() {
                ok = false;
                // A failed call returns its deposit to the vault: give it back to the creator.
                if *back > 0 {
                    let bal = self.balance_of(&user_id).checked_add(*back).expect("overflow");
                    self.user_balances.insert(user_id.clone(), bal);
                }
            }
        }
        if !ok {
            return self.fail_listing(&token_id, "prepare");
        }
        let token_is_x = token_id < self.wnear;
        let pool_id = if token_is_x { format!("{}|{}|{}", token_id, self.wnear, DCL_FEE) } else { format!("{}|{}|{}", self.wnear, token_id, DCL_FEE) };
        let mut h = self.held.get(&token_id).cloned().expect("held");
        h.pool_id = Some(pool_id.clone());
        self.held.insert(token_id.clone(), h);
        let (amount_x, amount_y) = if token_is_x { (params.pool_amount, U128(0)) } else { (U128(0), params.pool_amount) };
        // HotZap with an empty swap = deposit + add_liquidity in one ft_transfer_call. The plain
        // "Deposit" message ran out of gas on testnet DCL for accounts like ours (any Tgas).
        let msg = json!({ "HotZap": {
            "swap_infos": [{ "pool_ids": [], "input_token": token_id, "output_token": token_id, "amount_in": "0", "min_output_amount": "0" }],
            "add_liquidity_infos": [{
                "pool_id": pool_id, "left_point": params.left_point, "right_point": params.right_point,
                "amount_x": amount_x, "amount_y": amount_y, "min_amount_x": "0", "min_amount_y": "0",
            }],
        }})
        .to_string();
        Promise::new(token_id.clone())
            .function_call(
                "ft_transfer_call",
                json!({ "receiver_id": self.dcl, "amount": params.pool_amount, "msg": msg }).to_string().into_bytes(),
                ONE_YOCTO,
                GAS_FT_TRANSFER_CALL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_LIQUIDITY)
                    .with_unused_gas_weight(1)
                    .on_zapped(token_id),
            )
    }

    /// After the HotZap: `used` > 0 means liquidity was added; look the position up to hand it over.
    #[private]
    pub fn on_zapped(&mut self, token_id: AccountId, #[callback_result] used: Result<U128, PromiseError>) -> Promise {
        match used {
            Ok(u) if u.0 > 0 => Promise::new(self.dcl.clone())
                .function_call(
                    "list_liquidities",
                    json!({ "account_id": env::current_account_id() }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_VIEW_LIST,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_LIQUIDITY)
                        .with_unused_gas_weight(1)
                        .on_liquidity_added(token_id),
                ),
            _ => self.fail_listing(&token_id, "add_liquidity"),
        }
    }

    #[private]
    pub fn on_liquidity_added(&mut self, token_id: AccountId, #[callback_result] lpts: Result<Vec<near_sdk::serde_json::Value>, PromiseError>) -> Promise {
        let mut h = self.held.get(&token_id).cloned().expect("held");
        let pool = h.pool_id.clone().unwrap_or_default();
        let lpt = lpts.ok().and_then(|v| {
            v.into_iter()
                .filter(|p| p.get("pool_id").and_then(|x| x.as_str()) == Some(pool.as_str()))
                .filter_map(|p| p.get("lpt_id").and_then(|x| x.as_str()).map(str::to_string))
                .last()
        });
        match lpt {
            Some(lpt_id) => {
                h.lpt_id = Some(lpt_id);
                self.held.insert(token_id.clone(), h);
                self.hand_off(&token_id, false)
            }
            None => self.fail_listing(&token_id, "find_position"),
        }
    }

    /// Creator, relayer or owner: (re)tries handing a held token's position and balance to its
    /// creator, withdrawing anything left in the vault's DCL account first.
    pub fn release(&mut self, token_id: AccountId) -> Promise {
        let h = self.held.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("token is not held"));
        let caller = env::predecessor_account_id();
        require!(
            caller == h.creator || caller == self.owner_id || self.authorized_relayers.contains(&caller),
            "only the creator, owner or a relayer"
        );
        require!(!h.listing || h.pool_id.is_some() || caller == self.owner_id, "listing in progress");
        self.hand_off(&token_id, true)
    }

    /// NEP-141 receiver: a creator sends their own Yeetpad token here with msg `list_on_rhea` to have
    /// it listed (e.g. a launch made with "None", or a listing that failed). Anything else is refunded.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        let ours = token.as_str().strip_suffix(&format!(".{}", self.ft_factory)).filter(|t| !t.contains('.'));
        let Some(ticker) = ours.filter(|_| msg == "list_on_rhea") else {
            return amount;
        };
        match self.held.get(&token) {
            Some(h) if h.creator != sender_id || h.listing => return amount,
            Some(_) => {}
            None => {
                self.held.insert(token.clone(), Held { creator: sender_id.clone(), ticker: ticker.to_string(), pool_id: None, lpt_id: None, listing: false });
            }
        }
        emit("hold", json!({ "account_id": sender_id, "token_id": token, "amount": amount }));
        U128(0)
    }

    /// After `withdraw_asset` (success or not): hand the position and balance over.
    #[private]
    pub fn on_withdrawn(&mut self, token_id: AccountId) -> Promise {
        self.hand_off(&token_id, false)
    }

    /// Results: [nft_transfer?, ft_balance_of].
    #[private]
    pub fn on_hand_off(&mut self, token_id: AccountId, had_lpt: bool) -> Promise {
        let n = env::promise_results_count();
        let mut nft_ok = !had_lpt;
        let mut balance: u128 = 0;
        for i in 0..n {
            let r = env::promise_result_checked(i, 256);
            if had_lpt && i == 0 {
                nft_ok = r.is_ok();
            } else if let Ok(b) = r {
                balance = near_sdk::serde_json::from_slice::<U128>(&b).map(|v| v.0).unwrap_or(0);
            }
        }
        let mut h = self.held.get(&token_id).cloned().expect("held");
        let creator = h.creator.clone();
        let lpt = h.lpt_id.clone();
        if nft_ok {
            h.lpt_id = None;
        }
        let done = nft_ok;
        h.listing = false;
        if done && h.pool_id.is_some() {
            self.held.remove(&token_id);
        } else {
            self.held.insert(token_id.clone(), h.clone());
        }
        emit(
            if had_lpt && nft_ok { "listed" } else { "released" },
            json!({
                "account_id": creator, "token_id": token_id, "pool_id": h.pool_id, "lpt_id": lpt,
                "position_to_creator": had_lpt && nft_ok, "tokens_to_creator": U128(balance),
            }),
        );
        if balance > 0 {
            Promise::new(token_id).function_call(
                "ft_transfer",
                json!({ "receiver_id": creator, "amount": U128(balance), "memo": "Yeetpad: your tokens" }).to_string().into_bytes(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
        } else {
            Promise::new(env::current_account_id())
        }
    }

    // ---------- owner ----------

    pub fn add_relayer(&mut self, account_id: AccountId) -> bool {
        self.assert_owner();
        emit("relayer_added", json!({ "account_id": account_id }));
        self.authorized_relayers.insert(account_id)
    }

    pub fn remove_relayer(&mut self, account_id: AccountId) -> bool {
        self.assert_owner();
        emit("relayer_removed", json!({ "account_id": account_id }));
        self.authorized_relayers.remove(&account_id)
    }

    /// Replace the whole relayer set.
    pub fn set_relayers(&mut self, relayers: Vec<AccountId>) {
        self.assert_owner();
        self.authorized_relayers.clear();
        for r in relayers.iter() {
            self.authorized_relayers.insert(r.clone());
        }
        emit("relayers_set", json!({ "relayers": relayers }));
    }

    pub fn set_platform_fee_bps(&mut self, bps: u16) {
        self.assert_owner();
        require!(bps <= MAX_FEE_BPS, "fee bps > 10000");
        self.platform_fee_bps = bps;
        emit("fee_set", json!({ "platform_fee_bps": bps }));
    }

    pub fn set_ft_factory(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.ft_factory = account_id;
    }

    /// Rhea DCL exchange and wNEAR used by `list_on_rhea`.
    pub fn set_dcl(&mut self, dcl: AccountId, wnear: AccountId) {
        self.assert_owner();
        emit("dcl_set", json!({ "dcl": dcl, "wnear": wnear }));
        self.dcl = dcl;
        self.wnear = wnear;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit(if paused { "paused" } else { "unpaused" }, json!({ "by": self.owner_id }));
    }

    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.pending_owner = Some(new_owner);
    }

    pub fn accept_owner(&mut self) {
        let caller = env::predecessor_account_id();
        require!(self.pending_owner.as_ref() == Some(&caller), "not the pending owner");
        emit("owner_changed", json!({ "old_owner": self.owner_id, "new_owner": caller }));
        self.owner_id = caller;
        self.pending_owner = None;
    }

    pub fn withdraw_treasury(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        self.treasury_balance = self
            .treasury_balance
            .checked_sub(amount.0)
            .unwrap_or_else(|| env::panic_str("insufficient treasury"));
        emit("treasury_withdraw", json!({ "amount": amount }));
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Owner-only upgrade: input is the raw new wasm; deploys it and calls `migrate`.
    pub fn update_contract(&self) -> Promise {
        self.assert_owner();
        let code = env::input().unwrap_or_else(|| env::panic_str("pass the new wasm as input"));
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call("migrate".to_string(), vec![], NearToken::from_yoctonear(0), GAS_FOR_MIGRATE)
    }

    // ---------- views ----------

    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balance_of(&account_id))
    }

    pub fn get_held(&self, token_id: AccountId) -> Option<Held> {
        self.held.get(&token_id).cloned()
    }

    pub fn get_relayers(&self) -> Vec<AccountId> {
        self.authorized_relayers.iter().cloned().collect()
    }

    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({
            "owner_id": self.owner_id,
            "pending_owner": self.pending_owner,
            "ft_factory": self.ft_factory,
            "platform_fee_bps": self.platform_fee_bps,
            "treasury_balance": U128(self.treasury_balance),
            "paused": self.paused,
            "max_batch": MAX_BATCH,
            "dcl": self.dcl,
            "wnear": self.wnear,
            "version": env!("CARGO_PKG_VERSION"),
        })
    }
}

impl LaunchVault {
    /// Sends the position (if the vault still owns one) and the vault's whole token balance to the
    /// creator. `withdraw` first pulls any token deposit left in the vault's DCL account.
    fn hand_off(&mut self, token_id: &AccountId, withdraw: bool) -> Promise {
        let h = self.held.get(token_id).cloned().expect("held");
        let me = env::current_account_id();
        if withdraw {
            return Promise::new(self.dcl.clone())
                .function_call(
                    "withdraw_asset",
                    json!({ "token_id": token_id }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_WITHDRAW_ASSET,
                )
                .then(Self::ext(me).with_static_gas(GAS_ON_LIQUIDITY).with_unused_gas_weight(1).on_withdrawn(token_id.clone()));
        }
        // Built only now: near-sdk schedules a Promise when it is dropped.
        let balance = Promise::new(token_id.clone()).function_call(
            "ft_balance_of",
            json!({ "account_id": me }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_VIEW,
        );
        let had_lpt = h.lpt_id.is_some();
        let chain = match &h.lpt_id {
            Some(lpt) => Promise::new(self.dcl.clone())
                .function_call(
                    "nft_transfer",
                    json!({ "receiver_id": h.creator, "token_id": lpt }).to_string().into_bytes(),
                    ONE_YOCTO,
                    GAS_NFT_TRANSFER,
                )
                .and(balance),
            None => balance,
        };
        chain.then(
            Self::ext(me)
                .with_static_gas(GAS_ON_BALANCE)
                .with_unused_gas_weight(1)
                .on_hand_off(token_id.clone(), had_lpt),
        )
    }

    fn fail_listing(&mut self, token_id: &AccountId, step: &str) -> Promise {
        let h = self.held.get(token_id).cloned().expect("held");
        emit("list_failed", json!({ "account_id": h.creator, "token_id": token_id, "step": step }));
        log!("listing {} failed at {}; handing tokens to the creator", token_id, step);
        self.hand_off(token_id, true)
    }

    fn launch_one(&mut self, user_id: &AccountId, token: TokenArgs, deposit: U128, fee: u128) -> Promise {
        let hold = token.hold_for_listing == Some(true);
        let symbol = token.symbol.clone().unwrap_or_else(|| token.ticker.to_uppercase());
        let metadata = json!({
            "spec": "ft-1.0.0",
            "name": token.name,
            "symbol": symbol,
            "icon": token.icon,
            "reference": null,
            "reference_hash": null,
            "decimals": token.decimals.unwrap_or(18),
        });
        emit(
            "launch_start",
            json!({ "account_id": user_id, "ticker": token.ticker, "deposit": deposit, "fee": U128(fee) }),
        );
        Promise::new(self.ft_factory.clone())
            .function_call_weight(
                "create_token".to_string(),
                json!({
                    "ticker": token.ticker,
                    "metadata": metadata,
                    "total_supply": token.total_supply,
                    "owner_id": user_id,
                    "site": token.site,
                    "mint_to": if hold { Some(env::current_account_id()) } else { None },
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(deposit.0),
                GAS_FOR_FACTORY,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_LAUNCH_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_launch_complete(user_id.clone(), deposit, U128(fee), token.ticker, Some(hold)),
            )
    }

    fn check_batch(&self, tokens: &[TokenArgs], deposit_required: U128) {
        require!(!tokens.is_empty(), "no tokens");
        require!(tokens.len() <= MAX_BATCH, format!("at most {MAX_BATCH} launches per call"));
        require!(deposit_required.0 > 0, "deposit_required must be > 0");
        for (i, t) in tokens.iter().enumerate() {
            validate_ticker(&t.ticker);
            require!(t.total_supply.0 > 0, "total_supply must be > 0");
            require!(
                !tokens[..i].iter().any(|o| o.ticker == t.ticker),
                format!("duplicate ticker {} in batch", t.ticker)
            );
        }
    }

    fn balance_of(&self, a: &AccountId) -> u128 {
        self.user_balances.get(a).copied().unwrap_or(0)
    }

    /// Subtract with underflow / insufficient-balance guard. Returns new balance.
    fn debit(&mut self, a: &AccountId, amount: u128) -> u128 {
        let bal = self.balance_of(a);
        let left = bal.checked_sub(amount).unwrap_or_else(|| env::panic_str("insufficient balance"));
        // Keep the (zero) entry so the user's storage stays paid for.
        self.user_balances.insert(a.clone(), left);
        left
    }

    fn fee_for(&self, amount: u128) -> u128 {
        amount.checked_mul(self.platform_fee_bps as u128).expect("overflow") / 10_000
    }

    fn assert_relayer(&self) {
        require!(
            self.authorized_relayers.contains(&env::predecessor_account_id()),
            "only authorized relayers"
        );
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only owner");
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "vault is paused");
    }
}

fn default_dcl() -> AccountId {
    if env::current_account_id().as_str().ends_with(".testnet") { "dclv2.ref-dev.testnet" } else { "dclv2.ref-labs.near" }
        .parse()
        .unwrap()
}

fn default_wnear() -> AccountId {
    if env::current_account_id().as_str().ends_with(".testnet") { "wrap.testnet" } else { "wrap.near" }.parse().unwrap()
}

/// NEAR the creator pays for one listing (on top of the launch deposit).
pub fn listing_cost(p: &ListParams) -> u128 {
    prep_refunds(p).iter().sum::<u128>() + 2 * TOKEN_STORAGE
}

/// Deposit attached to each stage-A promise result, in result order (regs are not refunded).
pub fn prep_refunds(p: &ListParams) -> Vec<u128> {
    let mut v = vec![0];
    if p.skip_create_pool != Some(true) {
        v.push(p.pool_deposit.0);
    }
    if p.creator_dcl_storage.0 > 0 {
        v.push(p.creator_dcl_storage.0);
    }
    let t = p.vault_dcl_topup.map(|v| v.0).unwrap_or(0);
    if t > 0 {
        v.push(t);
    }
    v
}

/// One-sided range checks. Token as X: the whole range sits above the price (only X in it).
/// Token as Y: the range sits at or below the price (only Y in it). All points on the fee tier grid.
pub fn check_points(token_is_x: bool, init: i32, left: i32, right: i32) {
    for p in [init, left, right] {
        require!(p % DCL_POINT_DELTA == 0, "points must be multiples of 200");
        require!((-DCL_MAX_POINT..=DCL_MAX_POINT).contains(&p), "point out of range");
    }
    require!(left < right, "left_point must be < right_point");
    if token_is_x {
        require!(left > init, "token is X: left_point must be above init_point");
    } else {
        require!(right <= init, "token is Y: right_point must be <= init_point");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(pred: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("vault.test.near"))
            .predecessor_account_id(acc(pred))
            .attached_deposit(deposit)
            .build());
    }

    fn setup() -> LaunchVault {
        ctx("owner.near", NearToken::from_near(0));
        LaunchVault::new(acc("owner.near"), acc("factory.near"), Some(100), Some(vec![acc("relayer.near")]))
    }

    fn tok(t: &str) -> TokenArgs {
        TokenArgs { ticker: t.into(), name: "Moon".into(), symbol: None, icon: None, decimals: None, total_supply: U128(1), site: None, hold_for_listing: None }
    }

    /// Deposit and return the credited balance (gross minus first-deposit storage).
    fn deposit(v: &mut LaunchVault, who: &str, near: u128) -> u128 {
        ctx(who, NearToken::from_near(near));
        v.deposit_credits().0
    }


    fn params() -> ListParams {
        ListParams {
            pool_amount: U128(900),
            init_point: 0,
            left_point: 200,
            right_point: 500_000,
            pool_deposit: U128(NearToken::from_millinear(20).as_yoctonear()),
            creator_dcl_storage: U128(NearToken::from_millinear(500).as_yoctonear()),
            vault_dcl_topup: None,
            skip_create_pool: None,
        }
    }

    #[test]
    fn relist_via_ft_on_transfer() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 10);
        ctx("moon.factory.near", NearToken::from_near(0));
        assert_eq!(v.ft_on_transfer(acc("alice.near"), U128(5), "nope".into()).0, 5, "wrong msg refunded");
        assert_eq!(v.ft_on_transfer(acc("alice.near"), U128(5), "list_on_rhea".into()).0, 0);
        assert_eq!(v.get_held(acc("moon.factory.near")).unwrap().creator, acc("alice.near"));
        assert_eq!(v.ft_on_transfer(acc("bob.near"), U128(5), "list_on_rhea".into()).0, 5, "other creator refunded");
        ctx("evil.near", NearToken::from_near(0));
        assert_eq!(v.ft_on_transfer(acc("alice.near"), U128(5), "list_on_rhea".into()).0, 5, "not our token");
        ctx("relayer.near", NearToken::from_near(0));
        let mut p = params();
        p.skip_create_pool = Some(true);
        let before = v.get_balance(acc("alice.near")).0;
        let _ = v.list_on_rhea(acc("alice.near"), acc("moon.factory.near"), p.clone());
        assert_eq!(before - v.get_balance(acc("alice.near")).0, p.creator_dcl_storage.0 + 2 * TOKEN_STORAGE);
        assert_eq!(prep_refunds(&p).len(), 2);
    }

    #[test]
    fn zap_failure_releases() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 10);
        let id = held_launch(&mut v);
        ctx("relayer.near", NearToken::from_near(0));
        let _ = v.list_on_rhea(acc("alice.near"), id.clone(), params());
        with_results(vec![ok(b""), ok(b"\"p\""), ok(b"{}")]);
        let _ = v.on_list_prepared(acc("alice.near"), id.clone(), params());
        with_results(vec![]);
        let _ = v.on_zapped(id.clone(), Ok(U128(0)));
        assert!(v.get_held(id).unwrap().listing, "hand-off pending until on_hand_off");
    }

    fn with_results(results: Vec<near_sdk::PromiseResult>) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc("vault.test.near"))
                .predecessor_account_id(acc("vault.test.near"))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    fn ok(b: &[u8]) -> near_sdk::PromiseResult {
        near_sdk::PromiseResult::Successful(b.to_vec())
    }

    /// Launch "moon" held for listing and return the token id.
    fn held_launch(v: &mut LaunchVault) -> AccountId {
        ctx("relayer.near", NearToken::from_near(0));
        let mut t = tok("moon");
        t.hold_for_listing = Some(true);
        let _ = v.execute_sponsored_launch(acc("alice.near"), t, U128(NearToken::from_near(2).as_yoctonear()));
        ctx("vault.test.near", NearToken::from_near(0));
        let id = acc("moon.factory.near");
        v.on_launch_complete(acc("alice.near"), U128(0), U128(0), "moon".into(), Some(true), Ok(Some(id.clone())));
        id
    }

    #[test]
    fn rhea_listing_happy_path() {
        let mut v = setup();
        let b = deposit(&mut v, "alice.near", 10);
        let id = held_launch(&mut v);
        assert_eq!(v.get_held(id.clone()).unwrap().creator, acc("alice.near"));
        let after_launch = v.get_balance(acc("alice.near")).0;
        assert!(after_launch < b);
        ctx("relayer.near", NearToken::from_near(0));
        let _ = v.list_on_rhea(acc("alice.near"), id.clone(), params());
        assert_eq!(v.get_balance(acc("alice.near")).0, after_launch - listing_cost(&params()));
        assert!(v.get_held(id.clone()).unwrap().listing);
        let pool = "moon.factory.near|wrap.near|10000".to_string();
        with_results(vec![ok(b""), ok(&near_sdk::serde_json::to_vec(&pool).unwrap()), ok(b"{}")]);
        let _ = v.on_list_prepared(acc("alice.near"), id.clone(), params());
        assert_eq!(v.get_held(id.clone()).unwrap().pool_id, Some(pool.clone()));
        with_results(vec![]);
        let _ = v.on_zapped(id.clone(), Ok(U128(900)));
        let lp = near_sdk::serde_json::json!([{ "lpt_id": "other|x#1", "pool_id": "other" }, { "lpt_id": format!("{pool}#7"), "pool_id": pool }]);
        let _ = v.on_liquidity_added(id.clone(), Ok(lp.as_array().unwrap().clone()));
        assert_eq!(v.get_held(id.clone()).unwrap().lpt_id, Some("moon.factory.near|wrap.near|10000#7".into()));
        with_results(vec![ok(b""), ok(b"\"100\"")]);
        let _ = v.on_hand_off(id.clone(), true);
        assert!(v.get_held(id).is_none(), "done listings are forgotten");
    }

    #[test]
    fn rhea_prepare_failure_refunds_and_releases() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 10);
        let id = held_launch(&mut v);
        ctx("relayer.near", NearToken::from_near(0));
        let _ = v.list_on_rhea(acc("alice.near"), id.clone(), params());
        let after = v.get_balance(acc("alice.near")).0;
        with_results(vec![ok(b""), near_sdk::PromiseResult::Failed, near_sdk::PromiseResult::Failed]);
        let _ = v.on_list_prepared(acc("alice.near"), id.clone(), params());
        assert_eq!(v.get_balance(acc("alice.near")).0, after + params().pool_deposit.0 + params().creator_dcl_storage.0);
        with_results(vec![ok(b"\"1000\"")]);
        let _ = v.on_hand_off(id.clone(), false);
        let h = v.get_held(id).unwrap();
        assert!(!h.listing && h.pool_id.is_none());
    }

    #[test]
    fn nft_transfer_failure_keeps_position_for_release() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 10);
        let id = held_launch(&mut v);
        ctx("relayer.near", NearToken::from_near(0));
        let _ = v.list_on_rhea(acc("alice.near"), id.clone(), params());
        with_results(vec![ok(b""), ok(b"\"p\""), ok(b"{}")]);
        let _ = v.on_list_prepared(acc("alice.near"), id.clone(), params());
        let pool = v.get_held(id.clone()).unwrap().pool_id.unwrap();
        with_results(vec![]);
        let lp = near_sdk::serde_json::json!([{ "lpt_id": "p#1", "pool_id": pool }]);
        let _ = v.on_liquidity_added(id.clone(), Ok(lp.as_array().unwrap().clone()));
        with_results(vec![near_sdk::PromiseResult::Failed, ok(b"\"5\"")]);
        let _ = v.on_hand_off(id.clone(), true);
        let h = v.get_held(id.clone()).unwrap();
        assert_eq!(h.lpt_id.as_deref(), Some("p#1"));
        assert!(!h.listing);
        ctx("alice.near", NearToken::from_near(0));
        let _ = v.release(id); // creator may retry
    }

    #[test]
    #[should_panic(expected = "user is not the token's creator")]
    fn rhea_wrong_creator() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 10);
        let id = held_launch(&mut v);
        ctx("relayer.near", NearToken::from_near(0));
        let _ = v.list_on_rhea(acc("bob.near"), id, params());
    }

    #[test]
    #[should_panic(expected = "only authorized relayers")]
    fn rhea_relayer_only() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 10);
        let id = held_launch(&mut v);
        ctx("alice.near", NearToken::from_near(0));
        let _ = v.list_on_rhea(acc("alice.near"), id, params());
    }

    #[test]
    #[should_panic(expected = "only the creator, owner or a relayer")]
    fn release_guarded() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 10);
        let id = held_launch(&mut v);
        ctx("mallory.near", NearToken::from_near(0));
        let _ = v.release(id);
    }

    #[test]
    fn points_checks() {
        check_points(true, 0, 200, 500_000);
        check_points(false, 0, -500_000, 0);
        let bad = [(true, 0, 0, 200), (false, 0, -200, 200), (true, 0, 100, 500), (true, 0, 200, 900_000)];
        for (x, i, l, r) in bad {
            assert!(std::panic::catch_unwind(|| check_points(x, i, l, r)).is_err(), "{x} {i} {l} {r}");
        }
    }

    #[test]
    fn non_held_launch_not_recorded() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 10);
        ctx("vault.test.near", NearToken::from_near(0));
        v.on_launch_complete(acc("alice.near"), U128(0), U128(0), "aa".into(), None, Ok(Some(acc("aa.factory.near"))));
        assert!(v.get_held(acc("aa.factory.near")).is_none());
    }

    #[test]
    fn deposit_charges_storage_once_and_deduct() {
        let mut v = setup();
        let b1 = deposit(&mut v, "alice.near", 10);
        let storage = NearToken::from_near(10).as_yoctonear() - b1;
        assert!(storage > 0 && storage < NearToken::from_millinear(5).as_yoctonear(), "storage {storage}");
        let b2 = deposit(&mut v, "alice.near", 1);
        assert_eq!(b2, b1 + NearToken::from_near(1).as_yoctonear());
        ctx("relayer.near", NearToken::from_near(0));
        v.deduct_ai_compute(acc("alice.near"), U128(NearToken::from_millinear(200).as_yoctonear()));
        assert_eq!(v.get_balance(acc("alice.near")).0, b2 - NearToken::from_millinear(200).as_yoctonear());
    }

    #[test]
    #[should_panic(expected = "only authorized relayers")]
    fn non_relayer_rejected() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 1);
        v.deduct_ai_compute(acc("alice.near"), U128(1));
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn underflow_guard() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 1);
        ctx("relayer.near", NearToken::from_near(0));
        v.deduct_ai_compute(acc("alice.near"), U128(NearToken::from_near(2).as_yoctonear()));
    }

    #[test]
    #[should_panic(expected = "only owner")]
    fn only_owner_adds_relayer() {
        let mut v = setup();
        ctx("alice.near", NearToken::from_near(0));
        v.add_relayer(acc("alice.near"));
    }

    #[test]
    fn relayer_management_and_withdraw() {
        let mut v = setup();
        assert!(v.add_relayer(acc("r2.near")));
        assert_eq!(v.get_relayers().len(), 2);
        assert!(v.remove_relayer(acc("r2.near")));
        v.set_relayers(vec![acc("r3.near"), acc("r4.near")]);
        assert_eq!(v.get_relayers().len(), 2);
        let b = deposit(&mut v, "alice.near", 3);
        let _ = v.withdraw_unused(U128(NearToken::from_near(1).as_yoctonear()));
        assert_eq!(v.get_balance(acc("alice.near")).0, b - NearToken::from_near(1).as_yoctonear());
    }

    #[test]
    fn failed_launch_callback_refunds() {
        let mut v = setup();
        let b = deposit(&mut v, "alice.near", 10);
        ctx("relayer.near", NearToken::from_near(0));
        let dep = NearToken::from_near(4).as_yoctonear();
        let _ = v.execute_sponsored_launch(acc("alice.near"), tok("moon"), U128(dep));
        assert_eq!(v.get_balance(acc("alice.near")).0, b - dep - dep / 100);
        ctx("vault.test.near", NearToken::from_near(0));
        let r = v.on_launch_complete(acc("alice.near"), U128(dep), U128(dep / 100), "moon".into(), None, Err(PromiseError::Failed));
        assert!(r.is_none());
        assert_eq!(v.get_balance(acc("alice.near")).0, b);
    }

    #[test]
    fn batch_debits_all_and_refunds_per_item() {
        let mut v = setup();
        let b = deposit(&mut v, "alice.near", 20);
        ctx("relayer.near", NearToken::from_near(0));
        let dep = NearToken::from_near(2).as_yoctonear();
        let n = v.execute_sponsored_launch_batch(acc("alice.near"), vec![tok("aa"), tok("bb"), tok("cc")], U128(dep));
        assert_eq!(n, 3);
        let per = dep + dep / 100;
        assert_eq!(v.get_balance(acc("alice.near")).0, b - 3 * per);
        ctx("vault.test.near", NearToken::from_near(0));
        v.on_launch_complete(acc("alice.near"), U128(dep), U128(dep / 100), "aa".into(), None, Ok(Some(acc("aa.factory.near"))));
        v.on_launch_complete(acc("alice.near"), U128(dep), U128(dep / 100), "bb".into(), None, Ok(None));
        v.on_launch_complete(acc("alice.near"), U128(dep), U128(dep / 100), "cc".into(), None, Err(PromiseError::Failed));
        assert_eq!(v.get_balance(acc("alice.near")).0, b - per);
        assert_eq!(v.get_config()["treasury_balance"], json!(U128(dep / 100)));
    }

    #[test]
    #[should_panic(expected = "at most 5")]
    fn batch_limit() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 50);
        ctx("relayer.near", NearToken::from_near(0));
        let ts = ["aa", "bb", "cc", "dd", "ee", "ff"].iter().map(|t| tok(t)).collect();
        v.execute_sponsored_launch_batch(acc("alice.near"), ts, U128(1));
    }

    #[test]
    #[should_panic(expected = "duplicate ticker")]
    fn batch_rejects_duplicates() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 50);
        ctx("relayer.near", NearToken::from_near(0));
        v.execute_sponsored_launch_batch(acc("alice.near"), vec![tok("aa"), tok("aa")], U128(1));
    }

    #[test]
    #[should_panic(expected = "lowercase")]
    fn batch_validates_tickers() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 50);
        ctx("relayer.near", NearToken::from_near(0));
        v.execute_sponsored_launch_batch(acc("alice.near"), vec![tok("BAD!")], U128(1));
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn batch_needs_full_balance() {
        let mut v = setup();
        deposit(&mut v, "alice.near", 3);
        ctx("relayer.near", NearToken::from_near(0));
        v.execute_sponsored_launch_batch(acc("alice.near"), vec![tok("aa"), tok("bb")], U128(NearToken::from_near(2).as_yoctonear()));
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn paused_blocks_deposit() {
        let mut v = setup();
        v.set_paused(true);
        deposit(&mut v, "alice.near", 1);
    }

    #[test]
    fn paused_still_allows_withdraw() {
        let mut v = setup();
        let b = deposit(&mut v, "alice.near", 2);
        ctx("owner.near", NearToken::from_near(0));
        v.set_paused(true);
        ctx("alice.near", NearToken::from_near(0));
        let _ = v.withdraw_unused(U128(b));
        assert_eq!(v.get_balance(acc("alice.near")).0, 0);
    }

    #[test]
    fn owner_transfer_and_fee() {
        let mut v = setup();
        v.set_platform_fee_bps(250);
        v.propose_owner(acc("bob.near"));
        ctx("bob.near", NearToken::from_near(0));
        v.accept_owner();
        assert_eq!(v.get_config()["owner_id"], json!("bob.near"));
        assert_eq!(v.get_config()["platform_fee_bps"], json!(250));
    }

    #[test]
    #[should_panic(expected = "not the pending owner")]
    fn accept_owner_requires_proposal() {
        let mut v = setup();
        ctx("bob.near", NearToken::from_near(0));
        v.accept_owner();
    }
}

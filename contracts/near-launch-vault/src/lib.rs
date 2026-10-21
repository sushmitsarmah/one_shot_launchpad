//! Yeetpad launch vault: users deposit NEAR as credits; authorized relayers charge AI compute and
//! execute sponsored token launches (single or batches of up to 5) via the factory. Every launch
//! is debited up front and refunded per item if the factory call fails.
//!
//! Events: NEP-297 `EVENT_JSON` logs, standard `yeetpad_vault`, events
//! `deposit`, `charge`, `launch_start`, `launch`, `refund`, `withdraw` (+ admin events).
//! Admin: relayers, fee, pause/unpause, two-step owner transfer, `update_contract` + `migrate`.
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
pub const MAX_BATCH: usize = 5;
pub const MIN_TICKER_LEN: usize = 2;
pub const MAX_TICKER_LEN: usize = 16;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Relayers,
    Balances,
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
        }
    }

    /// Upgrade from the v0.1 layout. Balances, relayers and treasury are kept.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        use near_sdk::borsh::BorshDeserialize;
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no state to migrate"));
        if let Ok(cur) = LaunchVault::try_from_slice(&raw) {
            return cur; // already on this layout
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
        #[callback_result] result: Result<Option<AccountId>, PromiseError>,
    ) -> Option<AccountId> {
        match result {
            Ok(Some(token_id)) => {
                self.treasury_balance = self.treasury_balance.checked_add(fee.0).expect("overflow");
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
            "version": env!("CARGO_PKG_VERSION"),
        })
    }
}

impl LaunchVault {
    fn launch_one(&mut self, user_id: &AccountId, token: TokenArgs, deposit: U128, fee: u128) -> Promise {
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
                    .on_launch_complete(user_id.clone(), deposit, U128(fee), token.ticker),
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
        TokenArgs { ticker: t.into(), name: "Moon".into(), symbol: None, icon: None, decimals: None, total_supply: U128(1), site: None }
    }

    /// Deposit and return the credited balance (gross minus first-deposit storage).
    fn deposit(v: &mut LaunchVault, who: &str, near: u128) -> u128 {
        ctx(who, NearToken::from_near(near));
        v.deposit_credits().0
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
        let r = v.on_launch_complete(acc("alice.near"), U128(dep), U128(dep / 100), "moon".into(), Err(PromiseError::Failed));
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
        v.on_launch_complete(acc("alice.near"), U128(dep), U128(dep / 100), "aa".into(), Ok(Some(acc("aa.factory.near"))));
        v.on_launch_complete(acc("alice.near"), U128(dep), U128(dep / 100), "bb".into(), Ok(None));
        v.on_launch_complete(acc("alice.near"), U128(dep), U128(dep / 100), "cc".into(), Err(PromiseError::Failed));
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

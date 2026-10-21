//! Launch vault: users deposit NEAR as credits; authorized relayers deduct
//! AI compute costs and execute sponsored token launches via the factory.
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

const EVENT_STANDARD: &str = "launch_vault";
const EVENT_VERSION: &str = "1.0.0";
const GAS_FOR_FACTORY: Gas = Gas::from_tgas(150);
const GAS_FOR_LAUNCH_CALLBACK: Gas = Gas::from_tgas(15);
const MAX_FEE_BPS: u16 = 10_000;

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
    pub icon: Option<String>,
    pub decimals: Option<u8>,
    pub total_supply: U128,
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
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })
    ));
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
        }
    }

    // ---------- user ----------

    #[payable]
    pub fn deposit_credits(&mut self) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit");
        let user = env::predecessor_account_id();
        let new_bal = self.balance_of(&user).checked_add(amount).expect("overflow");
        self.user_balances.insert(user.clone(), new_bal);
        emit(
            "deposit_credits",
            json!({ "account_id": user, "amount": U128(amount), "balance": U128(new_bal) }),
        );
        U128(new_bal)
    }

    pub fn withdraw_unused(&mut self, amount: U128) -> Promise {
        require!(amount.0 > 0, "amount must be > 0");
        let user = env::predecessor_account_id();
        self.debit(&user, amount.0);
        emit("withdraw", json!({ "account_id": user, "amount": amount }));
        Promise::new(user).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---------- relayer ----------

    pub fn deduct_ai_compute(&mut self, user_id: AccountId, amount: U128) -> U128 {
        self.assert_relayer();
        require!(amount.0 > 0, "amount must be > 0");
        let left = self.debit(&user_id, amount.0);
        self.treasury_balance = self.treasury_balance.checked_add(amount.0).expect("overflow");
        emit(
            "deduct_ai_compute",
            json!({ "account_id": user_id, "amount": amount, "balance": U128(left) }),
        );
        U128(left)
    }

    /// Debits `deposit_required` (+ platform fee) from the user and asks the
    /// factory to create the token owned by `user_id`. Refunds on failure.
    pub fn execute_sponsored_launch(
        &mut self,
        user_id: AccountId,
        token: TokenArgs,
        deposit_required: U128,
    ) -> Promise {
        self.assert_relayer();
        require!(deposit_required.0 > 0, "deposit_required must be > 0");
        let fee = self.fee_for(deposit_required.0);
        let total = deposit_required.0.checked_add(fee).expect("overflow");
        self.debit(&user_id, total);

        let symbol = token
            .symbol
            .clone()
            .unwrap_or_else(|| token.ticker.to_uppercase());
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
            "launch_started",
            json!({ "account_id": user_id, "ticker": token.ticker, "deposit": deposit_required, "fee": U128(fee) }),
        );

        Promise::new(self.ft_factory.clone())
            .function_call(
                "create_token".to_string(),
                json!({
                    "ticker": token.ticker,
                    "metadata": metadata,
                    "total_supply": token.total_supply,
                    "owner_id": user_id,
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(deposit_required.0),
                GAS_FOR_FACTORY,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_LAUNCH_CALLBACK)
                    .on_launch_complete(user_id, deposit_required, U128(fee), token.ticker),
            )
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
                    "launch_succeeded",
                    json!({ "account_id": user_id, "token_id": token_id }),
                );
                Some(token_id)
            }
            _ => {
                // Factory either panicked (deposit auto-refunded to vault) or
                // refunded the deposit explicitly. Credit the user back.
                let refund = deposit.0.checked_add(fee.0).expect("overflow");
                let bal = self.balance_of(&user_id).checked_add(refund).expect("overflow");
                self.user_balances.insert(user_id.clone(), bal);
                log!("launch of {} failed, refunded {}", ticker, refund);
                emit(
                    "launch_refunded",
                    json!({ "account_id": user_id, "ticker": ticker, "amount": U128(refund) }),
                );
                None
            }
        }
    }

    // ---------- owner ----------

    pub fn add_relayer(&mut self, account_id: AccountId) -> bool {
        self.assert_owner();
        self.authorized_relayers.insert(account_id)
    }

    pub fn remove_relayer(&mut self, account_id: AccountId) -> bool {
        self.assert_owner();
        self.authorized_relayers.remove(&account_id)
    }

    pub fn set_platform_fee_bps(&mut self, bps: u16) {
        self.assert_owner();
        require!(bps <= MAX_FEE_BPS, "fee bps > 10000");
        self.platform_fee_bps = bps;
    }

    pub fn set_ft_factory(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.ft_factory = account_id;
    }

    pub fn withdraw_treasury(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        self.treasury_balance = self
            .treasury_balance
            .checked_sub(amount.0)
            .unwrap_or_else(|| env::panic_str("insufficient treasury"));
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(amount.0))
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
            "ft_factory": self.ft_factory,
            "platform_fee_bps": self.platform_fee_bps,
            "treasury_balance": U128(self.treasury_balance),
        })
    }
}

impl LaunchVault {
    fn balance_of(&self, a: &AccountId) -> u128 {
        self.user_balances.get(a).copied().unwrap_or(0)
    }

    /// Subtract with underflow / insufficient-balance guard. Returns new balance.
    fn debit(&mut self, a: &AccountId, amount: u128) -> u128 {
        let bal = self.balance_of(a);
        let left = bal
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("insufficient balance"));
        if left == 0 {
            self.user_balances.remove(a);
        } else {
            self.user_balances.insert(a.clone(), left);
        }
        left
    }

    fn fee_for(&self, amount: u128) -> u128 {
        amount
            .checked_mul(self.platform_fee_bps as u128)
            .expect("overflow")
            / 10_000
    }

    fn assert_relayer(&self) {
        require!(
            self.authorized_relayers
                .contains(&env::predecessor_account_id()),
            "only authorized relayers"
        );
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only owner"
        );
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

    #[test]
    fn deposit_and_deduct() {
        let mut v = setup();
        ctx("alice.near", NearToken::from_near(10));
        v.deposit_credits();
        assert_eq!(v.get_balance(acc("alice.near")).0, NearToken::from_near(10).as_yoctonear());
        ctx("relayer.near", NearToken::from_near(0));
        v.deduct_ai_compute(acc("alice.near"), U128(NearToken::from_millinear(200).as_yoctonear()));
        assert_eq!(v.get_balance(acc("alice.near")).0, NearToken::from_millinear(9800).as_yoctonear());
    }

    #[test]
    #[should_panic(expected = "only authorized relayers")]
    fn non_relayer_rejected() {
        let mut v = setup();
        ctx("alice.near", NearToken::from_near(1));
        v.deposit_credits();
        v.deduct_ai_compute(acc("alice.near"), U128(1));
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn underflow_guard() {
        let mut v = setup();
        ctx("alice.near", NearToken::from_near(1));
        v.deposit_credits();
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
        ctx("alice.near", NearToken::from_near(3));
        v.deposit_credits();
        let _ = v.withdraw_unused(U128(NearToken::from_near(1).as_yoctonear()));
        assert_eq!(v.get_balance(acc("alice.near")).0, NearToken::from_near(2).as_yoctonear());
    }

    #[test]
    fn failed_launch_callback_refunds() {
        let mut v = setup();
        ctx("alice.near", NearToken::from_near(10));
        v.deposit_credits();
        ctx("relayer.near", NearToken::from_near(0));
        let dep = NearToken::from_near(4).as_yoctonear();
        let _ = v.execute_sponsored_launch(
            acc("alice.near"),
            TokenArgs { ticker: "moon".into(), name: "Moon".into(), symbol: None, icon: None, decimals: None, total_supply: U128(1) },
            U128(dep),
        );
        // 4 NEAR + 1% fee debited
        assert_eq!(v.get_balance(acc("alice.near")).0, NearToken::from_near(10).as_yoctonear() - dep - dep / 100);
        ctx("vault.test.near", NearToken::from_near(0));
        let r = v.on_launch_complete(acc("alice.near"), U128(dep), U128(dep / 100), "moon".into(), Err(PromiseError::Failed));
        assert!(r.is_none());
        assert_eq!(v.get_balance(acc("alice.near")).0, NearToken::from_near(10).as_yoctonear());
    }
}

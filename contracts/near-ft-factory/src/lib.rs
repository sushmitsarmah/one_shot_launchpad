//! Token factory: `create_token` creates `<ticker>.<factory>`, deploys the embedded NEP-141 wasm
//! and mints the full supply to `owner_id` (or to `mint_to`, e.g. the vault seeding a Rhea pool;
//! the registry owner stays `owner_id`). Keeps a registry of launched tokens (by ticker and
//! by owner, paginated) plus an optional small site config per token for Yeetpad token pages.
//!
//! Admin: two-step owner transfer, pause/unpause, owner-only `update_contract` + `migrate`.
//!
//! Global token code (NEP-591, optional): the owner calls `publish_global_token` once (burns
//! 10x storage for the embedded token wasm from the factory's balance), then
//! `set_global_token(Some(hash))`. New tokens then `use_global_contract(hash)` instead of deploying
//! their own copy, so a launch needs ~0.076 NEAR instead of ~1.82. `set_global_token(None)` switches back.
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

pub const TOKEN_WASM: &[u8] = include_bytes!("../res/near_ft_token.wasm");

const GAS_FOR_TOKEN_INIT: Gas = Gas::from_tgas(20);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(8);
const GAS_FOR_MIGRATE: Gas = Gas::from_tgas(50);
/// Extra bytes on top of the wasm (account record, token state, metadata incl. icon, owner balance).
const EXTRA_STORAGE_BYTES: u128 = 12_000;
/// Bytes kept by the factory to pay for its registry entry (record + site + indexes).
const RECORD_STORAGE_BYTES: u128 = 3_500;
/// Storage charged for a global-contract reference (32-byte hash, rounded up generously).
const GLOBAL_REF_BYTES: u128 = 100;
/// Token state margin when the code is global (observed 1,161 bytes used incl. a ~1 KB icon).
const GLOBAL_EXTRA_STORAGE_BYTES: u128 = 4_000;
pub const MIN_TICKER_LEN: usize = 2;
pub const MAX_TICKER_LEN: usize = 16;
pub const MAX_SITE_BYTES: usize = 2_048;
pub const MAX_PAGE: u32 = 50;

const EVENT_STANDARD: &str = "yeetpad_factory";
const EVENT_VERSION: &str = "1.0.0";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Tokens,
    Tickers,
    ByOwner,
    Pending,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenRecord {
    pub ticker: String,
    pub token_id: AccountId,
    pub owner_id: AccountId,
    pub created_at_ms: U64,
    /// Opaque JSON for the Yeetpad token page (tagline, description, colours ...), <= 2 KiB.
    pub site: Option<String>,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Factory {
    owner_id: AccountId,
    tokens_created: u64,
    pending_owner: Option<AccountId>,
    paused: bool,
    tokens: LookupMap<String, TokenRecord>,
    tickers: Vector<String>,
    by_owner: LookupMap<AccountId, Vec<String>>,
    pending: LookupSet<String>,
    /// When set, new tokens use this global contract (sha256 of TOKEN_WASM) instead of a copy.
    global_token: Option<Base58CryptoHash>,
}

/// v0.2/v0.3 state (no global token), for `migrate`.
#[near(serializers = [borsh])]
pub struct FactoryV2 {
    owner_id: AccountId,
    tokens_created: u64,
    pending_owner: Option<AccountId>,
    paused: bool,
    tokens: LookupMap<String, TokenRecord>,
    tickers: Vector<String>,
    by_owner: LookupMap<AccountId, Vec<String>>,
    pending: LookupSet<String>,
}

/// v0.1 state, for `migrate`.
#[near(serializers = [borsh])]
pub struct FactoryV1 {
    owner_id: AccountId,
    tokens_created: u64,
}

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

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })
    ));
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self::from_parts(owner_id, 0)
    }

    /// Upgrade from the v0.1 layout (owner_id, tokens_created). Called by `update_contract`
    /// or directly by the account owner right after deploying new code.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        use near_sdk::borsh::BorshDeserialize;
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no state to migrate"));
        if let Ok(cur) = Factory::try_from_slice(&raw) {
            return cur; // already on this layout
        }
        if let Ok(o) = FactoryV2::try_from_slice(&raw) {
            return Self {
                owner_id: o.owner_id,
                tokens_created: o.tokens_created,
                pending_owner: o.pending_owner,
                paused: o.paused,
                tokens: o.tokens,
                tickers: o.tickers,
                by_owner: o.by_owner,
                pending: o.pending,
                global_token: None,
            };
        }
        let old = FactoryV1::try_from_slice(&raw).unwrap_or_else(|_| env::panic_str("unknown state layout"));
        Self::from_parts(old.owner_id, old.tokens_created)
    }

    // ---------- views ----------

    /// Attached deposit needed to cover storage of a new token account + its registry entry.
    pub fn get_required_deposit(&self) -> U128 {
        U128(self.required_deposit().as_yoctonear())
    }

    pub fn get_tokens_created(&self) -> u64 {
        self.tokens_created
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({
            "owner_id": self.owner_id,
            "pending_owner": self.pending_owner,
            "paused": self.paused,
            "tokens_created": self.tokens_created,
            "tokens_registered": self.tickers.len(),
            "required_deposit": U128(self.required_deposit().as_yoctonear()),
            "global_token": self.global_token,
            "token_code_hash": Base58CryptoHash::from(Self::token_code_hash()),
            "token_code_bytes": TOKEN_WASM.len(),
            "version": env!("CARGO_PKG_VERSION"),
        })
    }

    pub fn get_token(&self, ticker: String) -> Option<TokenRecord> {
        self.tokens.get(&ticker).cloned()
    }

    /// True if the ticker is registered or a launch for it is in flight.
    pub fn is_ticker_taken(&self, ticker: String) -> bool {
        self.tokens.contains_key(&ticker) || self.pending.contains(&ticker)
    }

    /// All registered tokens in launch order.
    pub fn get_tokens(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<TokenRecord> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE);
        (from..self.tickers.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.tickers.get(i).and_then(|t| self.tokens.get(t)).cloned())
            .collect()
    }

    /// Tokens owned by `owner_id`, newest first.
    pub fn get_tokens_by_owner(&self, owner_id: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<TokenRecord> {
        let list = match self.by_owner.get(&owner_id) {
            Some(l) => l,
            None => return vec![],
        };
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize;
        list.iter()
            .rev()
            .skip(from)
            .take(limit)
            .filter_map(|t| self.tokens.get(t).cloned())
            .collect()
    }

    pub fn get_tokens_count_by_owner(&self, owner_id: AccountId) -> u32 {
        self.by_owner.get(&owner_id).map(|l| l.len() as u32).unwrap_or(0)
    }

    // ---------- launch ----------

    #[payable]
    pub fn create_token(
        &mut self,
        ticker: String,
        metadata: FungibleTokenMetadata,
        total_supply: U128,
        owner_id: AccountId,
        site: Option<String>,
        mint_to: Option<AccountId>,
    ) -> Promise {
        require!(!self.paused, "factory is paused");
        validate_ticker(&ticker);
        metadata.assert_valid();
        require!(total_supply.0 > 0, "total_supply must be > 0");
        if let Some(s) = &site {
            require!(s.len() <= MAX_SITE_BYTES, format!("site config must be <= {MAX_SITE_BYTES} bytes"));
        }
        require!(!self.tokens.contains_key(&ticker), format!("ticker {ticker} is already taken"));
        require!(!self.pending.contains(&ticker), format!("ticker {ticker} is already being launched"));
        let required = self.required_deposit();
        let attached = env::attached_deposit();
        require!(
            attached >= required,
            format!(
                "attach at least {} yoctoNEAR for storage (got {})",
                required.as_yoctonear(),
                attached.as_yoctonear()
            )
        );
        let token_id: AccountId = format!("{ticker}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid token account id"));
        self.pending.insert(ticker.clone());

        // The factory keeps RECORD_STORAGE_BYTES worth of NEAR for its registry entry; the rest
        // funds the token account's storage.
        let reserve = Self::record_reserve();
        let to_token = attached.saturating_sub(reserve);

        let p = Promise::new(token_id.clone()).create_account().transfer(to_token);
        let p = match self.global_token {
            Some(h) => p.use_global_contract(near_sdk::CryptoHash::from(h)),
            None => p.deploy_contract(TOKEN_WASM.to_vec()),
        };
        p.function_call_weight(
                "new".to_string(),
                json!({ "owner_id": owner_id, "total_supply": total_supply, "metadata": metadata, "mint_to": mint_to })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FOR_TOKEN_INIT,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_token_created(
                        ticker,
                        token_id,
                        owner_id,
                        env::predecessor_account_id(),
                        U128(attached.as_yoctonear()),
                        site,
                    ),
            )
    }

    /// Returns the token id on success. On failure the NEAR sent to the token account comes back
    /// to the factory, and the full attached deposit is refunded to the caller; returns `None`.
    #[private]
    pub fn on_token_created(
        &mut self,
        ticker: String,
        token_id: AccountId,
        owner_id: AccountId,
        caller: AccountId,
        attached: U128,
        site: Option<String>,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> Option<AccountId> {
        self.pending.remove(&ticker);
        if result.is_ok() {
            self.tokens_created += 1;
            let record = TokenRecord {
                ticker: ticker.clone(),
                token_id: token_id.clone(),
                owner_id: owner_id.clone(),
                created_at_ms: U64(env::block_timestamp_ms()),
                site,
            };
            self.tokens.insert(ticker.clone(), record);
            self.tickers.push(ticker.clone());
            let mut list = self.by_owner.get(&owner_id).cloned().unwrap_or_default();
            list.push(ticker.clone());
            self.by_owner.insert(owner_id.clone(), list);
            emit("token_created", json!({ "ticker": ticker, "token_id": token_id, "owner_id": owner_id }));
            Some(token_id)
        } else {
            log!("token creation failed for {}, refunding {}", token_id, caller);
            emit("token_failed", json!({ "ticker": ticker, "token_id": token_id, "refund_to": caller, "amount": attached }));
            Promise::new(caller).transfer(NearToken::from_yoctonear(attached.0)).detach();
            None
        }
    }

    // ---------- owner ----------

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit(if paused { "paused" } else { "unpaused" }, json!({ "by": self.owner_id }));
    }

    /// Step 1 of an owner transfer; the new owner must call `accept_owner`.
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

    /// Publishes the embedded token wasm as a global contract (by code hash, so immutable).
    /// Burns `10 * storage_byte_cost * len` from the factory's own balance (~16.65 NEAR for
    /// 166.5 KB); top the factory up first. Does not switch launches over: see `set_global_token`.
    pub fn publish_global_token(&mut self) -> Promise {
        self.assert_owner();
        let hash = Base58CryptoHash::from(Self::token_code_hash());
        emit("global_token_published", json!({ "code_hash": hash, "bytes": TOKEN_WASM.len() }));
        Promise::new(env::current_account_id()).deploy_global_contract(TOKEN_WASM.to_vec())
    }

    /// Switch new launches to the global token code (`Some(hash)`, must equal the embedded
    /// wasm's sha256) or back to deploying a copy (`None`).
    pub fn set_global_token(&mut self, code_hash: Option<Base58CryptoHash>) {
        self.assert_owner();
        if let Some(h) = &code_hash {
            require!(
                near_sdk::CryptoHash::from(*h) == Self::token_code_hash(),
                "code_hash must be the sha256 of the embedded token wasm (see get_config.token_code_hash)"
            );
        }
        self.global_token = code_hash;
        emit("global_token_set", json!({ "code_hash": code_hash }));
    }

    /// Owner-only upgrade: input is the raw new wasm; deploys it and calls `migrate`.
    pub fn update_contract(&self) -> Promise {
        self.assert_owner();
        let code = env::input().unwrap_or_else(|| env::panic_str("pass the new wasm as input"));
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call("migrate".to_string(), vec![], NearToken::from_yoctonear(0), GAS_FOR_MIGRATE)
    }
}

impl Factory {
    fn from_parts(owner_id: AccountId, tokens_created: u64) -> Self {
        Self {
            owner_id,
            tokens_created,
            pending_owner: None,
            paused: false,
            tokens: LookupMap::new(StorageKey::Tokens),
            tickers: Vector::new(StorageKey::Tickers),
            by_owner: LookupMap::new(StorageKey::ByOwner),
            pending: LookupSet::new(StorageKey::Pending),
            global_token: None,
        }
    }

    fn token_code_hash() -> near_sdk::CryptoHash {
        env::sha256_array(TOKEN_WASM)
    }

    fn record_reserve() -> NearToken {
        env::storage_byte_cost().saturating_mul(RECORD_STORAGE_BYTES)
    }

    /// Token account storage (its own wasm copy unless global code is used) + registry entry.
    fn required_deposit(&self) -> NearToken {
        let token = if self.global_token.is_some() {
            GLOBAL_REF_BYTES + GLOBAL_EXTRA_STORAGE_BYTES
        } else {
            TOKEN_WASM.len() as u128 + EXTRA_STORAGE_BYTES
        };
        env::storage_byte_cost().saturating_mul(token + RECORD_STORAGE_BYTES)
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only owner");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::metadata::FT_METADATA_SPEC;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, PromiseError};

    fn meta() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.into(),
            name: "Moon".into(),
            symbol: "MOON".into(),
            icon: Some("data:image/svg+xml,%3Csvg%3E%3C/svg%3E".into()),
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }

    fn ctx(pred: usize, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("factory.test.near".parse().unwrap())
            .predecessor_account_id(accounts(pred))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    fn self_ctx() {
        testing_env!(VMContextBuilder::new()
            .current_account_id("factory.test.near".parse().unwrap())
            .predecessor_account_id("factory.test.near".parse().unwrap())
            .build());
    }

    #[test]
    fn ticker_validation() {
        validate_ticker("moon");
        validate_ticker("ab12");
    }

    #[test]
    #[should_panic(expected = "lowercase")]
    fn rejects_uppercase() {
        validate_ticker("MOON");
    }

    #[test]
    #[should_panic(expected = "chars")]
    fn rejects_long() {
        validate_ticker("abcdefghijklmnopq");
    }

    #[test]
    #[should_panic(expected = "start with a letter")]
    fn rejects_leading_digit() {
        validate_ticker("1abc");
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn requires_deposit() {
        ctx(0, 1);
        let mut f = Factory::new(accounts(0));
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), None, None);
    }

    #[test]
    fn create_registers_on_success_and_lists_by_owner() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        let req = f.get_required_deposit().0;
        ctx(2, req);
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), Some("{\"tagline\":\"hi\"}".into()), None);
        assert!(f.is_ticker_taken("moon".into()));
        self_ctx();
        let id = f.on_token_created(
            "moon".into(),
            "moon.factory.test.near".parse().unwrap(),
            accounts(1),
            accounts(2),
            U128(req),
            Some("{\"tagline\":\"hi\"}".into()),
            Ok(()),
        );
        assert_eq!(id.unwrap().as_str(), "moon.factory.test.near");
        assert_eq!(f.get_tokens_created(), 1);
        let rec = f.get_token("moon".into()).unwrap();
        assert_eq!(rec.owner_id, accounts(1));
        assert_eq!(rec.site.as_deref(), Some("{\"tagline\":\"hi\"}"));
        assert_eq!(f.get_tokens_by_owner(accounts(1), None, None).len(), 1);
        assert_eq!(f.get_tokens(None, None).len(), 1);
        assert_eq!(f.get_tokens_count_by_owner(accounts(1)), 1);
    }

    #[test]
    #[should_panic(expected = "already taken")]
    fn rejects_duplicate_ticker() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        let req = f.get_required_deposit().0;
        ctx(2, req);
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), None, None);
        self_ctx();
        f.on_token_created("moon".into(), "moon.factory.test.near".parse().unwrap(), accounts(1), accounts(2), U128(req), None, Ok(()));
        ctx(2, req);
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), None, None);
    }

    #[test]
    #[should_panic(expected = "already being launched")]
    fn rejects_in_flight_duplicate() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        let req = f.get_required_deposit().0;
        ctx(2, req);
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), None, None);
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), None, None);
    }

    #[test]
    fn failed_creation_frees_ticker() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        let req = f.get_required_deposit().0;
        ctx(2, req);
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), None, None);
        self_ctx();
        let r = f.on_token_created("moon".into(), "moon.factory.test.near".parse().unwrap(), accounts(1), accounts(2), U128(req), None, Err(PromiseError::Failed));
        assert!(r.is_none());
        assert!(!f.is_ticker_taken("moon".into()));
        assert_eq!(f.get_tokens_created(), 0);
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn paused_blocks_create() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        f.set_paused(true);
        let req = f.get_required_deposit().0;
        ctx(2, req);
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), None, None);
    }

    #[test]
    #[should_panic(expected = "only owner")]
    fn only_owner_pauses() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        ctx(1, 0);
        f.set_paused(true);
    }

    #[test]
    fn two_step_owner_transfer() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        f.propose_owner(accounts(3));
        ctx(3, 0);
        f.accept_owner();
        assert_eq!(f.get_owner(), accounts(3));
    }

    #[test]
    #[should_panic(expected = "site config must be")]
    fn rejects_big_site() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        let req = f.get_required_deposit().0;
        ctx(2, req);
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), Some("x".repeat(MAX_SITE_BYTES + 1)), None);
    }

    #[test]
    fn global_token_lowers_deposit_and_can_be_switched_off() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        let full = f.get_required_deposit().0;
        let hash = Base58CryptoHash::from(Factory::token_code_hash());
        f.set_global_token(Some(hash));
        let global = f.get_required_deposit().0;
        let b = env::storage_byte_cost().as_yoctonear();
        assert_eq!(full - global, b * (TOKEN_WASM.len() as u128 + EXTRA_STORAGE_BYTES - GLOBAL_REF_BYTES - GLOBAL_EXTRA_STORAGE_BYTES));
        assert_eq!(global, b * 7_600, "0.076 NEAR per launch with global code");
        // create_token works with the smaller deposit
        ctx(2, global);
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1), None, None);
        ctx(0, 0);
        f.set_global_token(None);
        assert_eq!(f.get_required_deposit().0, full);
    }

    #[test]
    #[should_panic(expected = "code_hash must be the sha256")]
    fn global_token_rejects_other_hash() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        f.set_global_token(Some(Base58CryptoHash::from([7u8; 32])));
    }

    #[test]
    #[should_panic(expected = "only owner")]
    fn only_owner_publishes_global() {
        ctx(0, 0);
        let mut f = Factory::new(accounts(0));
        ctx(1, 0);
        let _ = f.publish_global_token();
    }

    #[test]
    fn migrates_v2_layout() {
        use near_sdk::borsh::BorshSerialize;
        ctx(0, 0);
        let v2 = FactoryV2 {
            owner_id: accounts(0),
            tokens_created: 7,
            pending_owner: None,
            paused: true,
            tokens: LookupMap::new(StorageKey::Tokens),
            tickers: Vector::new(StorageKey::Tickers),
            by_owner: LookupMap::new(StorageKey::ByOwner),
            pending: LookupSet::new(StorageKey::Pending),
        };
        let mut buf = vec![];
        v2.serialize(&mut buf).unwrap();
        env::storage_write(b"STATE", &buf);
        let f = Factory::migrate();
        assert_eq!(f.get_tokens_created(), 7);
        assert_eq!(f.get_config()["paused"], true);
        assert_eq!(f.get_config()["global_token"], near_sdk::serde_json::Value::Null);
    }
}

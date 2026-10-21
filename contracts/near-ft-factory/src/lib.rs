//! Token factory: `create_token` creates `<ticker>.<factory>`, deploys the
//! embedded NEP-141 wasm and mints the full supply to `owner_id`.
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    env, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

pub const TOKEN_WASM: &[u8] = include_bytes!("../res/near_ft_token.wasm");

const GAS_FOR_TOKEN_INIT: Gas = Gas::from_tgas(30);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);
/// Extra bytes on top of the wasm (account record, token state, owner balance).
const EXTRA_STORAGE_BYTES: u128 = 10_000;
pub const MIN_TICKER_LEN: usize = 2;
pub const MAX_TICKER_LEN: usize = 16;

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Factory {
    owner_id: AccountId,
    tokens_created: u64,
}

pub fn validate_ticker(ticker: &str) {
    require!(
        (MIN_TICKER_LEN..=MAX_TICKER_LEN).contains(&ticker.len()),
        format!("ticker must be {MIN_TICKER_LEN}-{MAX_TICKER_LEN} chars")
    );
    require!(
        ticker
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
        "ticker must be lowercase a-z / 0-9"
    );
    require!(
        ticker.chars().next().unwrap().is_ascii_lowercase(),
        "ticker must start with a letter"
    );
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            tokens_created: 0,
        }
    }

    /// Attached deposit needed to cover storage of a new token account.
    pub fn get_required_deposit(&self) -> U128 {
        U128(Self::required_deposit().as_yoctonear())
    }

    pub fn get_tokens_created(&self) -> u64 {
        self.tokens_created
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    #[payable]
    pub fn create_token(
        &mut self,
        ticker: String,
        metadata: FungibleTokenMetadata,
        total_supply: U128,
        owner_id: AccountId,
    ) -> Promise {
        validate_ticker(&ticker);
        metadata.assert_valid();
        require!(total_supply.0 > 0, "total_supply must be > 0");
        let required = Self::required_deposit();
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

        Promise::new(token_id.clone())
            .create_account()
            .transfer(attached)
            .deploy_contract(TOKEN_WASM.to_vec())
            .function_call(
                "new".to_string(),
                json!({ "owner_id": owner_id, "total_supply": total_supply, "metadata": metadata })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FOR_TOKEN_INIT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_token_created(token_id, env::predecessor_account_id(), U128(attached.as_yoctonear())),
            )
    }

    /// Returns the token id on success. On failure the attached deposit (which
    /// came back to the factory) is refunded to the caller and `None` returned.
    #[private]
    pub fn on_token_created(
        &mut self,
        token_id: AccountId,
        caller: AccountId,
        attached: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> Option<AccountId> {
        if result.is_ok() {
            self.tokens_created += 1;
            log!("token created: {}", token_id);
            Some(token_id)
        } else {
            log!("token creation failed for {}, refunding {}", token_id, caller);
            Promise::new(caller).transfer(NearToken::from_yoctonear(attached.0)).detach();
            None
        }
    }
}

impl Factory {
    fn required_deposit() -> NearToken {
        env::storage_byte_cost()
            .saturating_mul(TOKEN_WASM.len() as u128 + EXTRA_STORAGE_BYTES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::metadata::FT_METADATA_SPEC;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn meta() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.into(),
            name: "Moon".into(),
            symbol: "MOON".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
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
    #[should_panic(expected = "attach at least")]
    fn requires_deposit() {
        testing_env!(VMContextBuilder::new()
            .current_account_id("factory.test.near".parse().unwrap())
            .attached_deposit(NearToken::from_millinear(1))
            .build());
        let mut f = Factory::new(accounts(0));
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1));
    }

    #[test]
    fn creates_with_enough_deposit() {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id("factory.test.near".parse().unwrap());
        testing_env!(ctx.build());
        let mut f = Factory::new(accounts(0));
        let req = f.get_required_deposit().0;
        testing_env!(ctx.attached_deposit(NearToken::from_yoctonear(req)).build());
        let _ = f.create_token("moon".into(), meta(), U128(1), accounts(1));
    }
}

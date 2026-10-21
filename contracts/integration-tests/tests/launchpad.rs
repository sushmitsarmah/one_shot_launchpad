//! End-to-end tests against a local near-sandbox.
//! Requires `contracts/build-contracts.sh` to have produced contracts/res/*.wasm.
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;

const SUPPLY: u128 = 1_000_000_000 * 10u128.pow(18);

fn wasm(name: &str) -> Vec<u8> {
    let p = format!("{}/../res/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|_| panic!("missing {p}; run contracts/build-contracts.sh"))
}

struct Env {
    _worker: Worker<near_workspaces::network::Sandbox>,
    vault: Contract,
    factory: Contract,
    relayer: Account,
    user: Account,
    stranger: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mk = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            let acc = root
                .create_subaccount(name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()?;
            anyhow::Ok(acc)
        }
    };
    let factory_acc = mk("factory", 30).await?;
    let vault_acc = mk("vault", 30).await?;
    let relayer = mk("relayer", 10).await?;
    let user = mk("alice", 30).await?;
    let stranger = mk("mallory", 10).await?;

    let factory = factory_acc.deploy(&wasm("near_ft_factory")).await?.into_result()?;
    factory
        .call("new")
        .args_json(json!({ "owner_id": factory_acc.id() }))
        .transact()
        .await?
        .into_result()?;

    let vault = vault_acc.deploy(&wasm("near_launch_vault")).await?.into_result()?;
    vault
        .call("new")
        .args_json(json!({
            "owner_id": vault_acc.id(),
            "ft_factory": factory.id(),
            "platform_fee_bps": 0,
            "relayers": [relayer.id()],
        }))
        .transact()
        .await?
        .into_result()?;

    Ok(Env { _worker: worker, vault, factory, relayer, user, stranger })
}

async fn balance(e: &Env) -> anyhow::Result<u128> {
    let v: String = e
        .vault
        .view("get_balance")
        .args_json(json!({ "account_id": e.user.id() }))
        .await?
        .json()?;
    Ok(v.parse()?)
}

async fn deposit(e: &Env, near: u128) -> anyhow::Result<()> {
    e.user
        .call(e.vault.id(), "deposit_credits")
        .deposit(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn required_deposit(e: &Env) -> anyhow::Result<String> {
    Ok(e.factory.view("get_required_deposit").await?.json()?)
}

async fn launch(e: &Env, ticker: &str) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let dep = required_deposit(e).await?;
    Ok(e.relayer
        .call(e.vault.id(), "execute_sponsored_launch")
        .args_json(json!({
            "user_id": e.user.id(),
            "token": { "ticker": ticker, "name": "Moon Coin", "total_supply": SUPPLY.to_string() },
            "deposit_required": dep,
        }))
        .max_gas()
        .transact()
        .await?)
}

#[tokio::test]
async fn deposit_deduct_and_auth() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, 10).await?;
    assert_eq!(balance(&e).await?, NearToken::from_near(10).as_yoctonear());

    let r = e
        .relayer
        .call(e.vault.id(), "deduct_ai_compute")
        .args_json(json!({ "user_id": e.user.id(), "amount": NearToken::from_millinear(200).as_yoctonear().to_string() }))
        .transact()
        .await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(balance(&e).await?, NearToken::from_millinear(9_800).as_yoctonear());

    let r = e
        .stranger
        .call(e.vault.id(), "deduct_ai_compute")
        .args_json(json!({ "user_id": e.user.id(), "amount": "1" }))
        .transact()
        .await?;
    assert!(r.is_failure());
    assert!(format!("{r:?}").contains("only authorized relayers"));
    assert_eq!(balance(&e).await?, NearToken::from_millinear(9_800).as_yoctonear());
    Ok(())
}

#[tokio::test]
async fn launch_mints_full_supply_to_user() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, 10).await?;
    let before = balance(&e).await?;
    let dep: u128 = required_deposit(&e).await?.parse()?;

    let r = launch(&e, "moon").await?;
    assert!(r.is_success(), "{r:?}");
    let token_id: Option<String> = r.json()?;
    let token_id = token_id.expect("token id");
    assert_eq!(token_id, format!("moon.{}", e.factory.id()));
    assert_eq!(balance(&e).await?, before - dep);

    let token_id: near_workspaces::AccountId = token_id.parse()?;
    let bal: String = e
        .user
        .view(&token_id, "ft_balance_of")
        .args_json(json!({ "account_id": e.user.id() }))
        .await?
        .json()?;
    assert_eq!(bal, SUPPLY.to_string());
    let total: String = e.user.view(&token_id, "ft_total_supply").await?.json()?;
    assert_eq!(total, SUPPLY.to_string());
    Ok(())
}

#[tokio::test]
async fn withdraw_unused_works() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, 10).await?;
    let wallet_before = e.user.view_account().await?.balance;
    e.user
        .call(e.vault.id(), "withdraw_unused")
        .args_json(json!({ "amount": NearToken::from_near(4).as_yoctonear().to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(balance(&e).await?, NearToken::from_near(6).as_yoctonear());
    let wallet_after = e.user.view_account().await?.balance;
    assert!(wallet_after > wallet_before.saturating_add(NearToken::from_millinear(3_900)));

    // over-withdraw rejected
    let r = e
        .user
        .call(e.vault.id(), "withdraw_unused")
        .args_json(json!({ "amount": NearToken::from_near(7).as_yoctonear().to_string() }))
        .transact()
        .await?;
    assert!(r.is_failure());
    Ok(())
}

#[tokio::test]
async fn failed_launch_refunds_user() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, 10).await?;
    let before = balance(&e).await?;

    // invalid ticker -> factory panics -> vault callback refunds
    let r = launch(&e, "BAD!").await?;
    assert!(r.is_success(), "{r:?}");
    let out: Option<String> = r.json()?;
    assert!(out.is_none());
    assert_eq!(balance(&e).await?, before);

    // duplicate ticker -> account creation fails -> factory refunds -> vault refunds
    assert!(launch(&e, "dupe").await?.json::<Option<String>>()?.is_some());
    let after_first = balance(&e).await?;
    let r = launch(&e, "dupe").await?;
    let dbg = format!("{r:?}");
    assert!(r.json::<Option<String>>()?.is_none(), "{dbg}");
    assert_eq!(balance(&e).await?, after_first);
    Ok(())
}

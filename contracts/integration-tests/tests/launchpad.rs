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
    let b0 = balance(&e).await?;
    // first deposit pays for its own balance entry (a few hundred bytes)
    assert!(b0 < NearToken::from_near(10).as_yoctonear() && b0 > NearToken::from_millinear(9_990).as_yoctonear());

    let r = e
        .relayer
        .call(e.vault.id(), "deduct_ai_compute")
        .args_json(json!({ "user_id": e.user.id(), "amount": NearToken::from_millinear(200).as_yoctonear().to_string() }))
        .transact()
        .await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(balance(&e).await?, b0 - NearToken::from_millinear(200).as_yoctonear());

    let r = e
        .stranger
        .call(e.vault.id(), "deduct_ai_compute")
        .args_json(json!({ "user_id": e.user.id(), "amount": "1" }))
        .transact()
        .await?;
    assert!(r.is_failure());
    assert!(format!("{r:?}").contains("only authorized relayers"));
    assert_eq!(balance(&e).await?, b0 - NearToken::from_millinear(200).as_yoctonear());
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
    let b0 = balance(&e).await?;
    let wallet_before = e.user.view_account().await?.balance;
    e.user
        .call(e.vault.id(), "withdraw_unused")
        .args_json(json!({ "amount": NearToken::from_near(4).as_yoctonear().to_string() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(balance(&e).await?, b0 - NearToken::from_near(4).as_yoctonear());
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

    // invalid ticker -> rejected by the vault before anything is debited
    let r = launch(&e, "BAD!").await?;
    assert!(r.is_failure(), "{r:?}");
    assert!(format!("{r:?}").contains("lowercase"));
    assert_eq!(balance(&e).await?, before);

    // duplicate ticker -> factory registry rejects it -> deposit returns -> vault refunds
    assert!(launch(&e, "dupe").await?.json::<Option<String>>()?.is_some());
    let after_first = balance(&e).await?;
    let r = launch(&e, "dupe").await?;
    let dbg = format!("{r:?}");
    assert!(r.json::<Option<String>>()?.is_none(), "{dbg}");
    assert_eq!(balance(&e).await?, after_first);
    Ok(())
}

async fn launch_batch(e: &Env, tickers: &[&str]) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let dep = required_deposit(e).await?;
    let tokens: Vec<_> = tickers
        .iter()
        .map(|t| json!({ "ticker": t, "name": format!("{t} coin"), "total_supply": SUPPLY.to_string(),
                         "icon": "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
                         "site": format!("{{\"tagline\":\"{t}\"}}") }))
        .collect();
    Ok(e.relayer
        .call(e.vault.id(), "execute_sponsored_launch_batch")
        .args_json(json!({ "user_id": e.user.id(), "tokens": tokens, "deposit_required": dep }))
        .max_gas()
        .transact()
        .await?)
}

fn events(r: &near_workspaces::result::ExecutionFinalResult, name: &str) -> Vec<serde_json::Value> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .filter(|v| v["standard"] == "yeetpad_vault" && v["event"] == name)
        .map(|v| v["data"][0].clone())
        .collect()
}

#[tokio::test]
async fn batch_of_five_launches_and_registry() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, 25).await?;
    let before = balance(&e).await?;
    let dep: u128 = required_deposit(&e).await?.parse()?;

    let r = launch_batch(&e, &["aa", "bb", "cc", "dd", "ee"]).await?;
    assert!(r.is_success(), "{r:?}");
    let ok = events(&r, "launch");
    assert_eq!(ok.len(), 5, "{:?}", r.logs());
    println!("batch of 5 burnt {} Tgas", r.total_gas_burnt.as_tgas());
    assert_eq!(r.json::<u32>()?, 5);
    assert_eq!(balance(&e).await?, before - 5 * dep);

    // registry views
    let mine: Vec<serde_json::Value> = e
        .factory
        .view("get_tokens_by_owner")
        .args_json(json!({ "owner_id": e.user.id(), "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(mine.len(), 5);
    assert_eq!(mine[0]["ticker"], "ee"); // newest first
    assert_eq!(mine[0]["site"], "{\"tagline\":\"ee\"}");
    let page: Vec<serde_json::Value> = e.factory.view("get_tokens").args_json(json!({ "from_index": 1, "limit": 2 })).await?.json()?;
    assert_eq!(page.len(), 2);
    assert_eq!(page[0]["ticker"], "bb");

    // icon made it into the token metadata
    let token_id: near_workspaces::AccountId = format!("aa.{}", e.factory.id()).parse()?;
    let meta: serde_json::Value = e.user.view(&token_id, "ft_metadata").await?.json()?;
    assert!(meta["icon"].as_str().unwrap().starts_with("data:image/svg+xml"));
    Ok(())
}

#[tokio::test]
async fn batch_partial_failure_refunds_only_failed_items() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, 20).await?;
    assert!(launch(&e, "taken").await?.json::<Option<String>>()?.is_some());
    let before = balance(&e).await?;
    let dep: u128 = required_deposit(&e).await?.parse()?;

    let r = launch_batch(&e, &["fresh", "taken"]).await?;
    assert!(r.is_success(), "{r:?}");
    assert_eq!(events(&r, "launch").len(), 1);
    let refunds = events(&r, "refund");
    assert_eq!(refunds.len(), 1);
    assert_eq!(refunds[0]["ticker"], "taken");
    assert_eq!(balance(&e).await?, before - dep);
    Ok(())
}

#[tokio::test]
async fn batch_rejects_over_limit_and_duplicates() -> anyhow::Result<()> {
    let e = setup().await?;
    deposit(&e, 20).await?;
    let before = balance(&e).await?;
    let r = launch_batch(&e, &["a1", "a2", "a3", "a4", "a5", "a6"]).await?;
    assert!(r.is_failure() && format!("{r:?}").contains("at most 5"));
    let r = launch_batch(&e, &["same", "same"]).await?;
    assert!(r.is_failure() && format!("{r:?}").contains("duplicate ticker"));
    assert_eq!(balance(&e).await?, before);
    Ok(())
}

#[tokio::test]
async fn pause_and_admin() -> anyhow::Result<()> {
    let e = setup().await?;
    let owner = e.vault.as_account();
    owner.call(e.vault.id(), "set_paused").args_json(json!({ "paused": true })).transact().await?.into_result()?;
    let r = e.user.call(e.vault.id(), "deposit_credits").deposit(NearToken::from_near(1)).transact().await?;
    assert!(r.is_failure() && format!("{r:?}").contains("paused"));
    let r = e.stranger.call(e.vault.id(), "set_paused").args_json(json!({ "paused": false })).transact().await?;
    assert!(r.is_failure() && format!("{r:?}").contains("only owner"));
    owner.call(e.vault.id(), "set_paused").args_json(json!({ "paused": false })).transact().await?.into_result()?;
    deposit(&e, 1).await?;
    Ok(())
}

/// Upgrade path: deploy the v0.1 wasm, create state, then `update_contract` to the new wasm.
/// Set OLD_WASM_DIR to a folder with the previous near_launch_vault.wasm / near_ft_factory.wasm.
#[tokio::test]
async fn upgrade_from_v1_keeps_state() -> anyhow::Result<()> {
    let Ok(dir) = std::env::var("OLD_WASM_DIR") else {
        eprintln!("OLD_WASM_DIR not set, skipping upgrade test");
        return Ok(());
    };
    let old = |n: &str| std::fs::read(format!("{dir}/{n}.wasm")).unwrap();
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let vault_acc = root.create_subaccount("vault").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
    let user = root.create_subaccount("alice").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let vault = vault_acc.deploy(&old("near_launch_vault")).await?.into_result()?;
    vault.call("new").args_json(json!({ "owner_id": vault_acc.id(), "ft_factory": "factory.test.near", "relayers": [user.id()] }))
        .transact().await?.into_result()?;
    user.call(vault.id(), "deposit_credits").deposit(NearToken::from_near(3)).transact().await?.into_result()?;

    let r = vault_acc.call(vault.id(), "update_contract").args(wasm("near_launch_vault")).max_gas().transact().await?;
    // v0.1 has no update_contract: fall back to deploy + migrate with the account key
    if r.is_failure() {
        vault_acc.deploy(&wasm("near_launch_vault")).await?.into_result()?;
        vault_acc.call(vault.id(), "migrate").transact().await?.into_result()?;
    }
    let bal: String = vault.view("get_balance").args_json(json!({ "account_id": user.id() })).await?.json()?;
    assert_eq!(bal, NearToken::from_near(3).as_yoctonear().to_string());
    let cfg: serde_json::Value = vault.view("get_config").await?.json()?;
    assert_eq!(cfg["paused"], false);
    let relayers: Vec<String> = vault.view("get_relayers").await?.json()?;
    assert_eq!(relayers, vec![user.id().to_string()]);

    // new code: update_contract works from here on (and migrate is idempotent)
    vault_acc.call(vault.id(), "update_contract").args(wasm("near_launch_vault")).max_gas().transact().await?.into_result()?;

    // factory
    let fac_acc = root.create_subaccount("factory").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
    let fac = fac_acc.deploy(&old("near_ft_factory")).await?.into_result()?;
    fac.call("new").args_json(json!({ "owner_id": fac_acc.id() })).transact().await?.into_result()?;
    fac_acc.deploy(&wasm("near_ft_factory")).await?.into_result()?;
    fac_acc.call(fac.id(), "migrate").transact().await?.into_result()?;
    let cfg: serde_json::Value = fac.view("get_config").await?.json()?;
    assert_eq!(cfg["owner_id"], fac_acc.id().to_string());
    Ok(())
}

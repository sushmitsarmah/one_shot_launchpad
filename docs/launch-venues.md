# Launch venues for mass launches: JustHoot, Nearly, Intear Launch, Rhea direct

Researched 2026-10-21 (IST). Nothing was signed or sent, and no write or upload endpoints were called. Sources: each site's JS bundles, contract view calls on fastnear RPC, nearblocks API + archival `EXPERIMENTAL_tx_status` for real launch txs, the Nearly docs page, and GitHub `INTEARnear/launch`. NearPad details are in `nearpad-integration.md`.
Labels: **[verified]** = seen on-chain or in code; **[unverified]** = inferred.

**Protocol gas limit [verified]:** `EXPERIMENTAL_protocol_config` returns `max_total_prepaid_gas` = **1 PGas (1000 Tgas)** per tx on both mainnet (protocol 86) and testnet (88). The old limit of 300 Tgas no longer applies. This also corrects the 300 Tgas assumption in `nearpad-integration.md`.

## Comparison

| | JustHoot | Nearly | Intear Launch | Rhea direct (own factory) |
|---|---|---|---|---|
| Factory | `v2-launchpad.justhoot.near` (+ `v2-pool-creator.justhoot.near`; v1 `launchpad.justhoot.near`) | `nearlytrade.near` (locker `lock2.nearlytrade.near`) | `launch-v2.intear.near` | Yeetpad `near-ft-factory` + `dclv2.ref-labs.near` / `v2.ref-finance.near` |
| Method | `launch_meme {args:{…}}` | `launch {args:{…}}` | `launch_token {…}` | `create_pool` + `ft_transfer_call` (DCL) |
| Gas per launch | 460 Tgas attached (`get_launch_gas` view: 446); ~79 Tgas burnt | 300 Tgas attached (documented); ~174 Tgas burnt | 300 Tgas attached; ~60 Tgas burnt | ~77 Tgas burnt (testnet NearPad-dev example in rhea-listing-plan.md) |
| Cost (no first buy) | **dynamic** via `get_launch_deposit`: 0.0378 NEAR with no icon, about 0.098 with a 7 KB icon; real tx 0.10571 | **dynamic** via `quote_launch`: 0.06185 with no icon, 0.09285 with a 3 KB icon; real tx 0.09476 | **exact** via `prepare_launch`: 0.01789 with no icon; real tx with icon 0.08356 | DCL storage only: pool 0.0094–0.05 + DCL storage 0.01–0.02 + registrations + token account |
| Pool | Rhea DCL, 1% tier, opening FDV $5k (oracle) | Rhea DCL, 1% tier, opening FDV 1,000 NEAR | **Intear's own DEX** (`dex.intear.near`, `slimedragon.near/xyk`). Not Rhea | Rhea DCL (or classic) |
| Image | `icon` must be a `data:image/` URI, ≤7000 chars (client check); stored on-chain | `icon` is a data URI or `https://`/`ipfs://`, ≤ `max_icon_bytes` = 16384 | `icon` is a data URI on-chain (size priced into deposit) | our choice |
| Metadata / socials | optional `reference` JSON uploaded through `POST https://backend-v2.meteorwallet.app/api/token_info/upload_token_metadata` (Meteor backend; files land in `storage.googleapis.com/justhoot/...`). `reference` can be null | **on-chain in args** (`description`, `links.website/twitter/telegram`). No upload needed | **on-chain** `launch_data {description, website, x, telegram, twitch}` | ours (KV + on-chain record) |
| Off-chain registration | none seen; the indexer reads `meme_launched` events [unverified] | none needed (docs describe events only); `POST /api/upload` is optional and only for the full-res site logo | none; the site reads `/launch/launch-data` from Intear's indexer | n/a |
| Testnet | **none** (`*.justhoot.testnet` don't exist) | **yes**: bundle testnet config `factory: dcl.nearpad-dev-4804.testnet`, `dcl: dclv2.ref-dev.testnet`. `get_config` and `quote_launch` work (0.19875 NEAR with a 3 KB icon). Last launches 2026-09-22; whether its schema matches mainnet is [unverified] | **none** (`launch-v2.intear.testnet` doesn't exist) | **yes**: `ref-finance-101.testnet` (v1.9.19), `dclv2.ref-dev.testnet` (v2.3.14), `wrap.testnet` |
| Multiple per tx | 2 max by gas (2×460=920 Tgas) [unverified] | 3 max by gas (3×300) [unverified] | 3 max by gas [unverified] | our contract can loop (vault already batches 1–5) |
| Ticker | not unique (account `<symbol>.v2-launchpad.justhoot.near`; a repeat still quotes, so it probably gets a suffix [unverified]) | not unique (`pepe-2.nearlytrade.near`) | not unique (`exmpl-1.launch-v2.intear.near`); a short id without suffix costs 1 NEAR | ours |
| Per-wallet limits | gate: `is_public_launch()` (true now) **or** `is_whitelisted_creator` | none documented | the creator can't be `dex.intear.near` or the factory; nothing else | ours |
| Live now | **yes** (`is_public_launch` = true; launches today) | **yes** (launches today; `launch_fee` 0) | **yes but early** (launch-v2 dates from about 2026-10-08; recent launches look like tests) | yes |

## 1. JustHoot (justhoot.fun) [verified unless marked]
- Config (`assets/config-*.js`): launchers `launchpad.justhoot.near:v1` and `v2-launchpad.justhoot.near:v2:v2-pool-creator.justhoot.near`. API is `https://api.justhoot.fun/api`, RPC `mw.rpc.fastnear.com`.
- Views: `get_platform_config` returns `{dcl_exchange_id:"dclv2.ref-labs.near", dcl_exchange_fee_pips:10000, pool_creator_id:"v2-pool-creator.justhoot.near", total_supply:1e27, token_decimals:18, initial_fiat_fdv:5000, price_oracle_id:"aggregate-oracle.near"}`. Other views: `get_launch_deposit {args, account_id}`, `get_launch_gas {args}`, `is_public_launch`, `is_whitelisted_creator {account_id}`, `get_allowed_quote_tokens`.
- Call (tx `5ZdUertm3EXiZ8Wf2G7RQiowveJC1LrgwPh8etaoj3kY`): receiver `v2-launchpad.justhoot.near`, `launch_meme`, gas 460 Tgas, deposit 0.10571 NEAR.
```json
{"args":{"name":"Brett","symbol":"BRETT","icon":"data:image/webp;base64,…",
 "reference":"https://storage.googleapis.com/justhoot/token_metadata/<sha>.json","reference_hash":"<b64 sha256>",
 "quote_token_id":"wrap.near","dev_buy_quote_max":null,"transfer_fee_pips":30000,
 "shares":{"token_owner_bps":3400,"burn_bps":3300,"holders_bps":3300}}}
```
- The deposit depends on the args, so call `get_launch_deposit` for each token. A first buy is funded by an extra deposit tx first (`ft_transfer_call` of wNEAR into the launcher), which the site sends as a batch. On failure the contract emits `launch_rejected` / `launch_failed` and refunds.
- Client rules: name 1–32 chars, symbol `^[A-Za-z0-9]{1,10}$`, icon must be a `data:image/` URL ≤7000 chars at 128 px.
- Notes: the whitelist gate could be closed at any time. The metadata upload goes to Meteor Wallet's backend; it is undocumented and we did not call it. You can skip it by sending `reference:null`, which loses the socials and website on-chain. I found no ToS page.

## 2. Nearly (nearly.trade) [verified unless marked]
- Has the best docs. Section "Launching from a contract or script": *"Call `launch` on `nearlytrade.near` with 300 TGas and the deposit from `quote_launch`. The caller becomes the creator…"* Programmatic launches are officially supported.
- `get_config`: `{total_supply:1e27, pool_fee:10000, init_point:0, min/max_init_point:-6800/15200, launch_fee:"0", creator_fee_share_bps:6000, dcl_storage_per_launch:0.02 NEAR, max_icon_bytes:16384, unique_symbols:false, max_dev_buy_bps:400}`.
- Cost: `quote_launch {icon_bytes, dev_buy, tax, text_bytes}` returns `{token_storage, record_storage, pool_create:0.014, dcl_storage:0.02, dev_buy, total}`. Attach `total`; any excess is refunded.
- Args (documented):
```json
{"args":{"name":"Example","symbol":"EXAMPLE","icon":"data:image/webp;base64,…",
 "description":"≤500 chars","links":{"website":"https://yeetpad.fun/t/example","twitter":null,"telegram":null},
 "dev_buy":null,"tax":{"buy_bps":0,"sell_bps":0,"creator_bps":10000,"burn_bps":0,"holders_bps":0}}}
```
  Optional fields: `quote` (from `get_quotes`; NEARLY/RHEA/ZEC pairs), `init_point`, `creator_paid_in`, `holders_paid_in`. Leave out `creator_share_bps`. Tax is ≤400 bps a side.
- Completion: the `launch_started` event, then `step == Done`, then the `launch` event. The full supply goes to the locker as a one-sided DCL position, and the creator share is paid out automatically.
- Testnet: `dcl.nearpad-dev-4804.testnet` on `dclv2.ref-dev.testnet`. The name suggests the same team as NearPad. Its config matches the mainnet shape.

## 3. Intear Launch (launch.intea.rs) [verified from source + tx]
- Source: github.com/INTEARnear/launch, `src/lib.rs` (pushed 2026-10-20, no license file). The site launch.intea.rs reads from Intear's indexer API.
- `launch_token` on `launch-v2.intear.near`, 300 Tgas. The attached deposit must be **exactly** `prepare_launch(...).deposit` ("Attach exactly … (see prepare_launch)").
```json
{"name":"Example","symbol":"exmpl","icon":"data:image/…","decimals":18,"total_supply":"1000000000000000000000000000",
 "short_id":false,"fees":null,
 "launch_data":{"description":"…","website":"https://yeetpad.fun/t/example","x":null,"telegram":null,"twitch":null},
 "first_buy":null,"quote_token":null}
```
  `prepare_launch` takes the same args plus `account_id` and returns `{token_account_id, deposit, errors[]}`. Example result: `exmpl-1.launch-v2.intear.near`, 0.01789 NEAR with no icon. Quote tokens are USDC and TEAR (`token.intear.near`); omit for NEAR.
- The pool is created on Intear's own DEX (`dex.intear.near`, `slimedragon.near/xyk`, 300 NEAR phantom liquidity), **not Rhea**. Rhea-routed traders and DexScreener coverage are [unverified].

## 4. Rhea direct (Yeetpad's own factory)
The detailed sequence is in `rhea-listing-plan.md`. These are the confirmed ids and formats.
- Mainnet: classic `v2.ref-finance.near` (v1.9.20), DCL `dclv2.ref-labs.near` (v2.3.15), `wrap.near`.
- Testnet: classic `ref-finance-101.testnet` (v1.9.19, `metadata` view OK), DCL `dclv2.ref-dev.testnet` (v2.3.14, `get_metadata` OK, state Running), `wrap.testnet`.
- DCL one-sided, observed inside the JustHoot launch receipts:
  1. `dcl.create_pool {token_a, token_b:"wrap.near", fee:10000, init_point}`. Deposits observed: 0.00941 (JustHoot), 0.014 (Nearly quote), 0.05 (NearPad, unused part refunded). The point must align with the tier's point delta (200 for fee 10000).
  2. `dcl.storage_deposit {account_id:<position owner>, registration_only:false}`, 0.01–0.02 NEAR.
  3. `token.storage_deposit {account_id:"dclv2…"}`.
  4. Add the position in one call: `token.ft_transfer_call {receiver_id: dcl, amount: supply, msg}` with
     `{"HotZap":{"swap_infos":[{"pool_ids":[],"input_token":T,"output_token":T,"amount_in":"0","min_output_amount":"0"}],"add_liquidity_infos":[{"pool_id":"T|wrap.near|10000","left_point":0,"right_point":500000,"amount_x":"<supply>","amount_y":"0","min_amount_x":"0","min_amount_y":"0"}]}}`. That call used 120 Tgas.
     The two-step alternative: `ft_transfer_call` with msg `"\"Deposit\""`, then `dcl.add_liquidity {pool_id,left_point,right_point,amount_x,amount_y,min_amount_x,min_amount_y}`.
  5. Afterwards, `withdraw_asset` returns any dust.
- Classic: `add_simple_pool {tokens:[T,wrap], fee:30}` (0.05 NEAR observed on mainnet), `register_tokens` / `storage_deposit` on ref, deposit both tokens with `ft_transfer_call msg:""`, then `add_liquidity {pool_id, amounts}` (0.01 NEAR). This needs real NEAR liquidity per pool, so it is not suited to 100 launches.
- **Minimum NEAR per launch (DCL):** about 0.03–0.05 for the pool and DCL storage, plus about 0.003 for registrations, plus the token account. The factory pattern NearPad/Nearly use comes to about 0.06–0.16 in total. Our own factory's token-account cost decides the real number [verify against `get_required_deposit`].
- Upside: works on testnet now, runs in our own factory (the vault already batches 1–5 per tx and can loop pool creation), and has no third-party gate or listing step.

## Batching (all venues)
- Every launch attaches a deposit, so function-call access keys can't sign them; each launch must go through the full-access wallet.
- Recommended: **one tx per launch**, many txs per `signAndSendTransactions` call (wallet-selector 10.x), in chunks of about 10–20 [unverified practical wallet limit]. Packing 2–3 launch actions into one tx fits under 1 PGas, but one failure reverts the tx's first receipt for all of them, and no venue's UI does this [untested].

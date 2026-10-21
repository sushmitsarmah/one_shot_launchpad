# NearPad launch integration: research notes

Researched 2026-10-21 (IST). Nothing was signed or sent. Sources: nearpad.family `/docs` and `/api`, the main bundle
`/assets/nearpad-core-rpc-demand-v1.js?v=20261012-visible-page-1` (`submitLaunch`, `getFormLaunch`, `pinLaunchMetadata`),
factory WASM via RPC `view_code`, recent `launch` txs via nearblocks API + fastnear archival RPC.
Legend: **[verified]** = seen in code/onchain; **[unverified]** = inferred, needs a test.

## 1. Contracts
| Role | Account | Notes |
|---|---|---|
| Launch factory / router (V4) | `nearpadfamily.near` | code_hash `3usuZzwirNfX3ourPVgdyy2ic9tsrwLHtjN7MqUKSjQh` (2026-10-21). No `__contract_abi` (MethodNotFound). [verified] |
| LP / position locker | `lock.nearpadfamily.near` | owns the DCL position + full minted supply [verified] |
| DEX | `dclv2.ref-labs.near` (Rhea DCL), fee tier 10000 | [verified] |
| Pair | `wrap.near` (also USDC `17208628…33a1`, `usdt.tether-token.near`, and managed pairs) | |
| Token accounts | `<slug>-<6hex>.nearpadfamily.near`, token template code hash `B2ohqcMiLy8DPfKJhCfvNxpnhEXYDsgy7urXmkiau4Uu` | |
| Legacy routers (not used for new launches) | `router-v2.richsite9012.near`, `router-v3.richsite9012.near`, treasury `richsite9012.near` | |

**Testnet:** `nearpadfamily.testnet` does not exist (UNKNOWN_ACCOUNT). The bundle and docs are mainnet-only. No testnet deployment was found. [verified for that name]

## 2. Launch call [verified from bundle + onchain txs]
One transaction with one FunctionCall: `receiverId: nearpadfamily.near`, `methodName: "launch"`, gas `300000000000000` (300 Tgas).
Deposit = `162250000000000000000000` (0.16225 NEAR) + `initial_buy_near` + (`1250000000000000000000` if initial_buy_near != "0").
The contract panics with `incorrect launch deposit`, so the deposit must be exact. (The docs page says 0.161 NEAR, which is out of date. The bundle constant `V4_LAUNCH_DEPOSIT` and `/launch-feed-v5/launch-ready.token_deployment_funding` both say 0.16225.)

Args (19 fields, real example from tx `75eADFBHCMnP5gYXWe7vSeqJWUhPhRxU1GspXTAvJCsw`):
```json
{
  "name": "$troll",                      // 2..40 bytes (client check)
  "symbol": "TROLL",                     // ^[A-Z0-9]{2,10}$, globally unique ("ticker already launched on NearPad"); pre-check view is_ticker_available {symbol}
  "icon": "https://<gateway>.mypinata.cloud/ipfs/<cid>",   // https URL (data URI also allowed by client), <= 4096 chars ("icon too large")
  "reference": "https://<gateway>.mypinata.cloud/ipfs/<cid>", // metadata JSON, must be https ("invalid metadata reference")
  "reference_hash": "base64(sha256(reference JSON bytes))",   // verified: matches for the troll example
  "left_point": 0,                       // wNEAR pair: 0 if `${slug}-` < "wrap.near" (token is X), else -499800
  "pair_asset": "wrap.near",
  "near_usd_micros": 5380000,            // live NEAR/USD * 1e6
  "custom_tax_bps": 0, "buy_tax_bps": 0, "sell_tax_bps": 0,   // 0..1000, steps of 10
  "tax_destination": "developer",        // "developer" | "holders"
  "tax_creator_bps": 10000, "tax_holders_bps": 0, "tax_burn_bps": 0,  // must sum to 10000
  "x_account": null,                     // optional X handle payout, ^[a-z0-9_]{1,15}$
  "first_buy_max_supply_bps": 400,       // 1..400
  "initial_buy_near": "0"                // yocto string; client allows 0.01..2 NEAR, wNEAR pair only
}
```
slug = `name.toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,34).replace(/^-|-$/g,"") || "token"`.
Stable pairs use `stablePoint = round(log(nearUsd/1e18)/log(1.0001)/200)*200` (see `getFormLaunch`).

Onchain flow inside the one tx: the factory emits `launch_configured`. It then calls `new` on the token subaccount, minting 1B supply (18 decimals) to `lock.nearpadfamily.near`, followed by storage deposits, `dclv2.ref-labs.near.create_pool {token_a, token_b:"wrap.near", fee:10000, init_point}` (0.05 NEAR), and `on_setup_complete`, which emits `launch_pool_created`. Total gas burnt was about 32 Tgas, and the scheduled sub-calls add up to about 86 Tgas. After that, an operator moves the launch to `launch_active` / lock. The creator does not sign again.

After the tx, the site POSTs `/launch-feed-v5/register-v4-launch` with the launch input + `{txHash, activationTxHash}` and retries every 5 s, up to 40 times. This makes the token appear in NearPad's registry/UI. Recovery endpoint: `/launch-feed-v5/recover-v4-launch`. Neither endpoint is documented. [verified in bundle; auth: none seen]

Useful views: `get_launch {token_id}`, `get_latest_launch {creator_id}`, `get_launch_count`, `is_ticker_available {symbol}`, `get_pair_quote {pair_asset}`. Status enum: `Creating | PoolCreated | Active`.

## 3. Image / metadata upload
- `GET /launch-feed-v5/metadata-ready` returns `{configured:true, gateway:"https://maroon-adorable-panther-740.mypinata.cloud/ipfs/"}`.
- `POST /launch-feed-v5/pin-metadata` with JSON body `{name, symbol, decimals:18, owner, description, website, twitter, telegram, imageDataUrl}` returns `metadata: {icon, site_icon, reference, reference_hash, image_cid, metadata_cid}`. There is no API key or wallet auth. The server pins to NearPad's own Pinata account. This is an undocumented internal endpoint, so its rate limits and abuse policy are unknown. **Not called** during this research.
- Metadata JSON schema (`nearpad-token-metadata-v1`): `{schema, network:"near-mainnet", name, symbol, decimals, description, image, image_ipfs, external_url, socials:{twitter,telegram}, creator, created_at}`.
- The contract itself only requires an https `reference` + a 32-byte hash, so pinning to our own IPFS/Pinata should pass onchain. **[unverified]** whether `register-v4-launch` accepts icons or references that are not on NearPad's gateway, and whether the site's coin page shows them.

## 4. Batching 100 launches

> **Correction (2026-10-21):** the protocol `max_total_prepaid_gas` is now 1 PGas per tx (mainnet protocol 86, verified via `EXPERIMENTAL_protocol_config`), so up to 3 NearPad `launch` actions (300 Tgas each) could fit in one tx gas-wise [still untested]. See `launch-venues.md`.
- Each launch attaches deposit, so a function-call access key can't be used (FC keys can't attach deposit). Every launch must be approved by the full-access wallet.
- **Multiple launches per tx: not recommended / [unverified].** The client attaches the full 300 Tgas, and the scheduled sub-calls use about 86 Tgas, so 2–3 per 300 Tgas tx might work in principle. However, the contract may check prepaid gas, and the site never does this. One failing action reverts the whole tx's direct state but not already-scheduled receipts, which makes this risky.
- **Recommended:** one tx per launch, many txs in one `wallet.signAndSendTransactions({transactions:[...]})` call (wallet-selector 10.x). One approval covers N txs in wallets that support it (MyNearWallet, Meteor, HERE, Intear). Some wallets prompt per tx or cap/time out on large batches. Use chunks of about 10–20 [unverified practical limit] and track each result.
- Constraints: tickers are globally unique (pre-check `is_ticker_available` for all 100 and dedupe). The site client refuses a new launch while `get_latest_launch(creator)` is `Creating`/`PoolCreated`. This check appears in the client. No matching panic string was found in the WASM, but `launch still settling` / `launch already progressed` exist **[unverified whether the contract serializes per creator]**. Budget: about 0.164 NEAR per launch (0.16225 + roughly 0.0007 gas fee), so about 16.4 NEAR for 100, plus any first buys.
- **Current blocker:** `/launch-feed-v5/launch-ready` right now returns `ready:false`, reason "Token launches are temporarily unavailable while the launch service reserve is replenished." The site gates on this endpoint. **[unverified]** whether the contract would also reject launches.

## 5. Terms / restrictions
- Docs: "provided as is"; "Do not imply an official partnership or endorsement without written permission." No `/terms` page (404). The public read API (`/api/v1`) needs no key. It asks clients to poll every 10–30 s and back off on 429.
- The write-side endpoints (`pin-metadata`, `register-v4-launch`) are internal and undocumented. Bulk use (100 launches) could be throttled or blocked, so contact NearPad (Builders page / Telegram) before shipping.
- Mass-creating tokens on a third-party launchpad can look like spam (and symbols are a shared namespace).

## 6. Rhea (ref-finance) pool creation, direct
- Classic AMM: `v2.ref-finance.near` method `add_simple_pool {tokens:[a,b], fee:30}`, deposit 0.05 NEAR (seen onchain). Liquidity then goes through `ft_transfer_call` deposits + `add_liquidity {pool_id, amounts}`. Before this NearPad's own older V1–V3 used this, with `storage_deposit`, `mft_register`, and `mft_transfer` for the LP lock.
- DCL: `dclv2.ref-labs.near` method `create_pool {token_a, token_b, fee, init_point}`, deposit 0.05 NEAR (seen in the NearPad receipt; init_point must align with the fee tier's point delta). Positions use `ft_transfer_call` with an add-liquidity msg **[msg format not checked]**.

## Recommended approach for Yeetpad
1. For each row: validate name/symbol, `is_ticker_available`, compute `left_point`, fetch NEAR/USD.
2. Pin image + metadata JSON. The preferred option is our own Pinata or IPFS, computing `reference_hash` = base64(sha256(json bytes)). The other option is NearPad `pin-metadata`, but only with their OK.
3. Check `launch-ready` and stop if `ready:false`.
4. Build N txs `{receiverId:"nearpadfamily.near", actions:[functionCall("launch", args, 300 Tgas, exactDeposit)]}` and send via `signAndSendTransactions` in chunks of about 10–20.
5. For each tx hash, POST `register-v4-launch` (with retries) so NearPad lists it, then confirm with `get_launch` until `Active`.
6. First, test with 1 launch, then a 2-tx batch, then 2 launches in one tx, all from a throwaway mainnet account, since there is no testnet.

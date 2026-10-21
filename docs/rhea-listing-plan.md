# Plan: Rhea (Ref) liquidity at launch

Goal: one click creates the token **and** opens its market on Rhea, and the buy button points at that market. Target is mainnet; build and prove it on testnet first.

Status: plan only (2026-10-21). Facts below were checked against live RPC and real transactions on that date; anything not verified is marked **(verify)**.

## 1. Findings

### Contracts (checked by RPC view calls)

| | mainnet | testnet |
|---|---|---|
| Rhea classic AMM | `v2.ref-finance.near` v1.9.20, 8,978 pools, wnear `wrap.near` | `ref-finance-101.testnet` v1.9.19, 2,814 pools, wnear `wrap.testnet` (also `exchange.ref-dev.testnet`, a dev copy) |
| Rhea DCL (concentrated liquidity) | `dclv2.ref-labs.near` v2.3.15, 5,770 pools | `dclv2.ref-dev.testnet` v2.3.14, 11,619 pools |
| wNEAR | `wrap.near` | `wrap.testnet` (24 decimals, live) |
| UI | app.rhea.finance | testnet.rhea.finance (up) |

**Testnet is usable.** Other launchpads launch real pools there today. The two transactions below are the reference flows, decoded from chain:

* **Classic, paired, LP burned** (dragonpad, tx `EZu7JxZt53vbwftEgUrtL9qyZpB3UHRQJMKAyPGCRLoE`, pool 2739, one 300 Tgas tx):
  `wrap.testnet.storage_deposit(0.00125)` → `near_deposit(5 NEAR)` →
  `ref.storage_deposit(0.005)` → `ref.register_tokens([token, wrap]) (1 yocto)` →
  `token.storage_deposit(account_id=ref, 0.00125)` → `token.ft_transfer_call(ref, amount, msg="") (1 yocto, 40 Tgas)` →
  `wrap.storage_deposit(ref)` → `wrap.ft_transfer_call(ref, 5 NEAR, msg="")` →
  `ref.add_simple_pool({tokens:[token, wrap], fee:30}) (0.05 NEAR; returns pool id u64)` →
  `ref.add_liquidity({pool_id, amounts, min_amounts}) (0.01 NEAR)` →
  `ref.mft_register({token_id:":<pool_id>", account_id:<burn acct>}) (0.01)` → `ref.mft_transfer(":<pool_id>", burn acct, shares) (1 yocto)` → `ref.unregister_tokens`.
  Each step is 8 Tgas plus a self-callback. Non-whitelisted tokens work: `register_tokens` puts them on the caller's own whitelist.
* **DCL, one-sided (token only, no NEAR), position locked** (NearPad dev, tx `DNtWq5zeeD3ohXbsHeKZv21KYhm7qBSpUERawEuK5y22`, **77 Tgas burnt**, 0.492 NEAR attached including the token account):
  token `new(owner_id = locker, total_supply)` →
  `dcl.create_pool({token_a, token_b:"wrap.testnet", fee:10000, init_point:0}) (0.1 NEAR, the unused part is refunded)` →
  `dcl.storage_deposit({account_id: locker, registration_only:false}) (0.02)` →
  `locker.add(...)` (0.012) → `token.storage_deposit(dcl, 0.00125)` → `token.ft_transfer_call(dcl, full supply, msg="\"Deposit\"")` →
  `dcl.add_liquidity({pool_id:"<token>|wrap.testnet|10000", left_point:200, right_point:500000, amount_x:supply, amount_y:"0", min_amount_x, min_amount_y:"0"})`, which returns an LP NFT owned by the locker.
  The mainnet NearPad docs (nearpad.family/docs) describe the same flow on `dclv2.ref-labs.near`:
  * cost 0.161 NEAR per launch (0.07 token account, 0.05 pool, 0.02 DCL storage, about 0.02 registrations);
  * tier 10000 (1%);
  * opening FDV 1,000 NEAR;
  * full supply placed one-sided;
  * the position is held by `lock.nearpadfamily.near`.

### Listing and visibility
* **Rhea UI.** Any pool is tradeable by token id. *Verified* display depends on the Rhea DAO token whitelist. The classic AMM has `auto_whitelisted_postfix`:
  * mainnet: `.tknx.near`, `.launch.shoremarkets.near`, `.meme-cooking.near`, `.tkn.near`, ...
  * testnet: `.tkns.testnet`, `meme-cooking.testnet`, ...

  For mainnet we should ask the Rhea DAO to add our factory suffix (e.g. `.ft-factory.yeetpad.near`). Until then tokens show as "unverified" and users import them by address.
* **DexScreener and GeckoTerminal** list a pool automatically once it has at least one trade. The id format for DCL pools is `refv2-<pool_id with | replaced by :>` (per the NearPad docs). Neither covers testnet.
* **Intear and other aggregators** are mainnet only and index Rhea pools; there is nothing to do on testnet.
* **Buy link:**
  * DCL pool page: `https://app.rhea.finance/poolV2/<token_x><><token_y>@<fee>` (the URL form was seen live).
  * Swap deep link: `https://app.rhea.finance/#wrap.near|<token>` is the legacy Ref format **(verify in a browser; the SPA returns 200 for anything)**.
  * Testnet: the same paths on `testnet.rhea.finance` **(verify)**.
  * Fallback: keep the nearblocks link and show the pool id.

## 2. Recommendation

**Use DCL, one-sided, at a fixed opening price, with the LP NFT held by a keyless locker contract. Run it as a separate "list" step per token right after the launch.**

Why:
* **No NEAR liquidity needed.** The creator and the platform only pay storage (about 0.15 NEAR). Buyers supply the NEAR side by buying, which behaves like a bonding curve over a price range.
* **Mint goes straight into the pool.** It is the pattern Rhea's own ecosystem (NearPad, nearpaid-dev on testnet) uses, so it is known to work end to end, on testnet too.
* **Cheap on gas.** Measured at about 77 Tgas burnt.

Classic AMM stays as an option (paired: creator or platform seeds N NEAR plus X% of supply; LP burned). It needs real NEAR per launch (5 NEAR in the dragonpad example), and a pool seeded with little NEAR is trivially manipulated.

| | DCL one-sided (recommended) | Classic paired |
|---|---|---|
| NEAR needed | ~0.15 storage only | storage ~0.08 **plus** the liquidity amount |
| Opening price | set by `init_point` and the range | ratio of the deposits |
| LP asset | NFT position (lpt_id) | fungible shares `:<pool_id>` (easy to burn) |
| Fee income | claimable by the position owner (locker can forward to the creator) | lost if burned |
| Rug risk | none if the locker has no withdraw | none if the shares are burned |
| Complexity | price/point maths, token order | simpler |

**Who holds what:** the creator gets a small creator allocation (default 0–10% of supply, chosen at launch). The rest goes one-sided into the pool. The position belongs to `lock.yeetpad.near` (on testnet `lock.osl-launchpad-5786.testnet`):
* a tiny contract with **no remove_liquidity / transfer method** and no full-access keys after deploy;
* only `claim_fees(token)`, which forwards fees to the creator (phase 2).

This removes the classic "creator pulls the LP" rug. The creator's own allocation can still be dumped, which is why the default allocation should be small, ideally vested.

## 3. Design

### Contracts
1. **Factory.** `create_token` gains `owner_id` semantics already; for listed launches it passes `owner_id = vault` (the token contract is unchanged: full supply goes to the owner). Record `pool_id` in `TokenRecord` (`set_pool(ticker, pool_id)`, callable by the vault only).
2. **Vault.** Add `list_on_rhea(user_id, ticker, params) -> Promise` (relayer only), idempotent per ticker. Steps:
   1. `token.storage_deposit(dcl)`, `token.storage_deposit(locker)`, `token.storage_deposit(creator)` (0.00125 each);
   2. `token.ft_transfer(creator, creator_share)`;
   3. `dcl.create_pool({token_a: token, token_b: wnear, fee: 10000, init_point})` (0.1 attached, the unused part is refunded);
   4. `dcl.storage_deposit(locker)` (0.02);
   5. `token.ft_transfer_call(locker, pool_amount, msg={pool_id, left_point, right_point})`, after which the locker deposits into the DCL and calls `add_liquidity` as the position owner;
   6. callback `on_listed`: store `pool_id` and `lpt_id`, emit `yeetpad_vault/listed`; on failure keep the tokens in the vault, emit `list_failed`, and allow a retry (no refund of supply needed; the storage NEAR is refunded to the user's credit).
   * Gas: about 80 Tgas burnt and 150–200 Tgas attached per token. That does not fit in a 5-token batch transaction, so launch stays batched and **listing is one relayer tx per token** sent right after the batch (the API does this). Optionally the vault can chain list into the single-token launch (40 + 150 Tgas fits in 300).
   * Charging: listing cost (~0.16 NEAR) is debited from the user's vault credit with the launch; refunded on failure.
3. **Locker** (new, about 150 lines): `on ft_transfer_call → dcl.add_liquidity`; views `get_position(token)`; `claim_fees(token)` (phase 2); no withdraw. After deploy, delete its full-access key or keep only a DAO multisig for `update_contract` **(decide)**.
4. **Price maths.** Opening FDV target (e.g. 1,000 NEAR for 1B supply means 1e-6 NEAR/token):
   * `point = log_1.0001(price × 10^(dec_y − dec_x))`, rounded to `point_delta` (fee 10000 → 200);
   * if our token is **token_x** (sorts before `wrap.*`), use the range `[init_point + delta, max]`; if it is **token_y**, use `[min, init_point − delta]`;
   * our tickers can sort either side of `wrap.near`, so both cases must be tested.

   Reuse NearPad's parameters as a starting point.

### API
* `POST /api/launch` and `/batch` take `listing: { enabled, creatorSharePct (0–10), openingFdvNear (default 1000) }`. After a successful launch they call `list_on_rhea` per token and add `poolId`, `buyUrl` and `listed` to the results and the SiteConfig.
* `GET /api/site/:id` and `/api/launches` expose `poolId` and `buyUrl`. A new `POST /api/list/:ticker` handles retries.
* Price helper: `openingPoint(fdv, supply, decimals, tokenIsX)` with unit tests against DCL `get_pool` and `quote` results.

### UI
* In the launch step: a "Open a Rhea market" toggle (on by default), creator share slider (0–10%), opening FDV (preset 1k / 5k / 10k NEAR), and a cost line ("1.82 + 0.16 NEAR").
* Token page: "Buy on Rhea" goes to `buyUrl`; also show the pool id, "liquidity locked" with a link to `locker.get_position`, a DexScreener link (mainnet), and an embedded quote via `dcl.quote` **(nice to have)**.
* My launches: badge "listed" or "list failed · retry".

## 4. Cost per launch (NEAR)

| item | testnet today | mainnet plan |
|---|---|---|
| token account (wasm storage) | ~1.80 (180 KB wasm per token) | **~0.07** with a NEAR global contract (`UseGlobalContract`, as NearPad does) |
| factory record + registrations | ~0.02 | ~0.02 |
| DCL pool + storage + registrations | ~0.15 (create_pool 0.1 is partly refunded) | ~0.15 |
| gas (about 120 Tgas total) | ~0.012 | ~0.012 |
| **total** | **~1.98** | **~0.25** |

Who pays: the user, from vault credit (as today), plus an optional platform fee (`platform_fee_bps`). One-sided DCL needs no seed liquidity. With the classic option, the seed NEAR must also come from the creator.

## 5. Testing

1. **Sandbox.** Pull the wasm from `dclv2.ref-dev.testnet` and `wrap.testnet` via RPC `view_code` and deploy them into near-workspaces. Add tests for:
   * a happy path for token_x and token_y;
   * a failed `create_pool` (pool exists) leads to a retry;
   * a buy through `dcl.swap` after listing moves the price up;
   * the locker has no way to withdraw;
   * a batch of 5 followed by 5 listings.
2. **Testnet.** Use the real `dclv2.ref-dev.testnet` and `wrap.testnet`, and the e2e account:
   * launch 2, list both, buy 0.1 NEAR worth via `ft_transfer_call` on wrap, then check the pool via `get_pool` and `quote`;
   * open testnet.rhea.finance to confirm the buy link works.
3. Keep classic AMM as a fallback behind a flag, tested against `ref-finance-101.testnet`.

## 6. Mainnet checklist
* **Accounts:** `yeetpad.near` (or similar) with `ft-factory.`, `launch-vault.`, `lock.` sub-accounts; treasury; a relayer key with function-call-only access to the vault; owner = multisig (e.g. a Sputnik DAO) rather than a hot key.
* **Contracts:** deploy the token wasm as a **global contract** (factory uses `UseGlobalContract`, so the token deposit drops from about 1.8 to about 0.07 NEAR); audit factory, vault and locker (or at least an external review); pause switch tested; upgrade path via DAO.
* **Rhea:** ask the Rhea DAO for an `auto_whitelisted_postfix` for our factory suffix; confirm the DCL fee tier and `point_delta`; confirm the buy-link format.
* **LLM:** switch `NEARAI_BASE_URL` / `NEARAI_MODEL` from the Ollama endpoint to NEAR AI Cloud (`https://cloud-api.near.ai/v1`), set a new `NEARAI_API_KEY` secret, re-tune `AI_COMPUTE_COST_YOCTO` to the real per-call cost, add rate limits.
* **Config:** `NEAR_RPC_URL` (mainnet, paid tier), `EXPLORER_BASE=https://nearblocks.io`, wallet-selector `network: mainnet`, NEP-413 recipient = mainnet vault id, new `SESSION_SECRET`, KV namespace per environment.
* **Legal and abuse:** ToS and risk disclosure, name/ticker blocklist (impersonation), per-account launch rate limits, content moderation of generated names and images.
* **Security review items:**
  * relayer key scope;
  * vault balance accounting under partial failures;
  * reentrancy across callbacks;
  * storage-staking drain;
  * the locker having no withdraw path;
  * HTML escaping on token pages (done).

## 7. Risks
* **Creator dump:** the creator share is sellable immediately. Keep it small, show it on the page, and consider vesting (phase 3).
* **Price-maths bugs:** a wrong token order or point gives a pool at a silly price. Mitigate with sandbox tests plus a `quote` check before marking the token listed.
* **Partial failure:** the token exists but is unlisted. Listing is a separate idempotent step with retry, so this is safe.
* **Rhea contract upgrades:** pin the method signatures in integration tests and monitor.
* **Front-running:** snipers can buy the first block. One-sided DCL at a fixed price limits the impact, and an optional creator first-buy in the same tx is possible (phase 3).
* **Locker key compromise:** if a full-access key remains, the "locked" claim is false. Delete keys, or use a DAO with a timelock.
* **Regulatory exposure:** this is a mainnet memecoin launchpad.

## 8. Phased tasks (rough effort)
| phase | work | effort |
|---|---|---|
| 1 | Sandbox harness with DCL and wrap wasm; price/point helper and tests; locker contract | 1.5–2 d |
| 2 | Vault `list_on_rhea` and callbacks, factory `set_pool`, events, migrate; testnet upgrade | 1.5 d |
| 3 | API listing params, per-token list after batch, retry endpoint, SiteConfig `poolId` and `buyUrl` | 1 d |
| 4 | UI: launch toggle, share and FDV inputs, token-page buy and "locked" panel, list status in My launches | 1 d |
| 5 | Testnet e2e (launch, list, buy, quote, page) and README | 0.5 d |
| 6 | Mainnet prep: global-contract token, accounts and DAO, NEAR AI switch, Rhea whitelist request, review | 2–3 d plus external review |
| later | Locker fee claims to the creator, creator vesting, classic-AMM option, DexScreener/quote embed | 1–2 d |

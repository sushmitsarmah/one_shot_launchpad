# Launch venues in Yeetpad Studio (testnet build, 2026-10-21)

Studio's "4. Yeet it" card has a **List on** picker: **None** (token only, as before), **Rhea (direct)**, **Nearly**.
It shows the cost per token and the total (from `/api/quote`, which reads the on-chain quote views) before you launch.

## Rhea direct (vault, one click, paid from vault credit)
1. `execute_sponsored_launch[_batch]` with `hold_for_listing: true`. The factory mints the supply to the vault (`mint_to`). The token's owner and the registry owner stay the creator.
2. The API calls the relayer-only `list_on_rhea(user_id, token_id, params)` once per token. This is one transaction of about 300 Tgas:
   - **A:** `token.storage_deposit` for the DCL and for the creator, `dcl.create_pool {token|wNEAR, fee 10000, init_point}`, and `dcl.storage_deposit(creator)`. The creator storage is 0.5 NEAR the first time; it belongs to the creator and can be withdrawn from Rhea.
   - **B:** `token.ft_transfer_call(dcl, pool_amount, HotZap{swap_infos:[{pool_ids:[],input=output=token,amount_in:"0"}], add_liquidity_infos:[{pool_id,left,right,amount_x|amount_y}]})`. This deposits and adds one-sided liquidity in one call.
     - The plain `"Deposit"` message then `add_liquidity` route now runs out of gas on testnet DCL v2.3.14 for any sender, whatever Tgas is attached. Nearly's own testnet factory fails the same way.
   - **C:** `dcl.list_liquidities(vault)` finds the new `lpt_id`. `dcl.nft_transfer(creator, lpt_id)` hands over the position, and `ft_transfer(creator, rest)` hands over the creator share plus dust.
   - Events: `listed`, `list_failed {step}` and `released`.
3. **Failure handling:** if any step fails, the vault runs `withdraw_asset` and sends the whole balance to the creator. If the position transfer fails, the record stays so `release(token_id)` can retry; the creator, relayer or owner may call it. Deposits from failed stage-A calls go back to the creator's credit.
4. **Re-list later:** `token.ft_transfer_call(vault, amount, "list_on_rhea")` (the vault only accepts `*.ft-factory…` tokens), then `POST /api/list/rhea {tokenId}`. If the pool already exists, the API passes `skip_create_pool` and builds the range from the pool's `current_point`.
5. Yeetpad keeps no LP, no fee share and no locker. The vault keeps only Rhea's refund of unused pool-creation NEAR (~0.01) and "already registered" storage refunds.

### Price math (`apps/orchestrator-api/src/rhea.ts`)
- The opening price is P = FDV / supply (NEAR per whole token). The default FDV is 1000 NEAR (`RHEA_DEFAULT_FDV_NEAR`; there is a per-launch field). With 1B supply, P = 1e-6 NEAR.
- DCL price at point p = 1.0001^p, measured in raw token_y per raw token_x.
- **Token sorts before `wrap.*` (token is X):** p = log(P·10^(24−dec)) / log(1.0001). The range is `[init+200, init+500000]`, which holds X only.
- **Token sorts after `wrap.*` (token is Y):** p = −that value. The range is `[init−500000, init]`, which holds Y only.
- Points are floored to the 200 grid and clamped to ±800000. 1000 NEAR FDV with 1B supply at 18 decimals gives p = 0.
- Live check: 0.01 wNEAR → 9,899 tokens, which is 10,000 at 1e-6 NEAR less the 1% fee.
- `creatorPct` (default 0) of the vault's holding goes to the creator; the rest goes to the pool.

### Live results (2026-10-22, v0.3.0)
- Fresh single launch `yrz6r36` (Y side) passed end to end. Launch: Gf5gi4oR1xkPeoLqx8kb7hznmADYK6SdSfgxw6ngWENu; listing: B91yNwFD5Zwz3KXgwubWYYi8N2SGjSoHuQ9W3gLKGp9p.
  - Creator owns `#2520`. A 0.01 wNEAR quote returns 9,899 tokens.
  - Credit spent: 1.84253.
- 2-token batch passed. Launch: 44EeCpWpEyMbnqSQst49WfKfVqmbP2BjHRupBXHLhAur.
  - `arz7ej0` (X side, range [200, 500000]; quote 9,704): listing B6LaJUtMuD5y7r6RaCMJyhzDUZXv83dTwHHMPBwy3xDS.
  - `zrz7ej0` (Y side): listing E2znBHNfAcT927Bsg7NEdXFmXuosduJXitLVsd6yj5Ab.
  - Credit spent: 3.68506. The batch took 24.5 s.
- Studio "list on Rhea" button: the two-action tx (vault `storage_deposit` + `ft_transfer_call … "list_on_rhea"`) followed by `/api/list/rhea` passed on `yrglz8c`. Listing: 2ujpKme24KW2XsnNtMQjhKZg5RsPD6vpwbAyMGT9qkXj; cost 0.0025.
- Plain `"Deposit"` into testnet DCL still runs out of gas, so Nearly's testnet factory is still broken. No new Nearly launches since #22.

## Nearly (creator's wallet signs)
- `POST /api/nearly/prepare` reserves the slug and builds `launch {args:{name,symbol,icon(SVG data URI ≤16 KB),description,links:{website: yeetpad.fun/t/<slug>},dev_buy:"0"}}`. It uses 300 Tgas and the deposit from `quote_launch`.
- Studio signs these with `signAndSendTransactions`, in chunks of `NEARLY_BATCH_CHUNK` (default 10).
- `POST /api/nearly/finalize` verifies each tx's `nearpad/launch` event (signer = creator). It then writes the site and KV `nearly-by:<account>`, and My launches lists the token with a venue link.
- Config: `NEARLY_FACTORY` (testnet `dcl.nearpad-dev-4804.testnet`, mainnet `nearlytrade.near`) and `NEARLY_ENABLED`.
- **Testnet status: broken.** A live launch (tx 7GozecqufDTkpm8kGXqfS8JhhjsNRk1nZmEcb1WKwMqR) stopped at step `AddLiquidity`: DCL `ft_on_transfer("Deposit")` hit "Exceeded the prepaid gas" and the locker logged "exchange did not accept the deposit". Nearly is therefore off by default (`NEARLY_ENABLED` unset) and Studio shows the reason.

## Costs observed on testnet
- Rhea: token account 1.82003 + pool 0.02 (~0.0101 used) + registrations 0.0025, plus 0.5 the first time for creator DCL storage.
  - First launch: 2.3425 credit. Later launches: 1.8425.
  - Re-list of an existing pool: 0.0025.
- Nearly: `quote_launch` 0.17058 for a ~1 KB icon. The wallet spent 0.2976 including gas.

## Mainnet checklist
- Set `DCL_CONTRACT=dclv2.ref-labs.near`, `WNEAR_CONTRACT=wrap.near` and the vault's `set_dcl` (defaults pick these for non-.testnet accounts).
- Sponsor the vault's DCL storage once: `bun scripts/dcl-register-vault.ts` (0.5 NEAR).
- Run a 0.1-NEAR-scale Rhea listing first. Check that HotZap on mainnet (used by JustHoot) also works through our vault.
- Use a global contract for the token wasm so token accounts cost ~0.07 instead of 1.82.
- `NEARLY_ENABLED=1`, `NEARLY_FACTORY=nearlytrade.near`. Check the `NEARLY_TOKEN_URL_BASE` page path (unverified).
- The Rhea pool URL (`RHEA_POOL_URL_BASE`, `/poolV2/<id with @>`) is unverified on testnet.

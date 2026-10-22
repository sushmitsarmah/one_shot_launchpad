# Mainnet deploy checklist

Everything is scripted and idempotent. `bun run deploy:mainnet` is a **read-only dry run** that prints the plan,
balances and an itemized budget; `bun run deploy:mainnet -- --execute` sends the transactions. Re-running skips
finished steps. Testnet keeps running unchanged on the current workers.

## Accounts

| Account | Role | Key |
|---|---|---|
| `294bca9c…df11a` (implicit) | deployer; funds everything once | `~/.secrets/near_mainnet_yeetpad_294bca9c.json` |
| `yeetpad.near` | owner/admin of factory + vault; pays DCL storage | same key as the deployer |
| `factory.yeetpad.near` | `near-ft-factory` v0.4 (creates tokens, holds global token code) | same key |
| `vault.yeetpad.near` | `near-launch-vault` (credits, launches, Rhea listing); NEP-413 recipient | same key |
| `relayer.yeetpad.near` | the API worker's signer; gas only, no owner rights | `~/.secrets/near_mainnet_relayer_yeetpad.json` (separate) |

All four `.near` names were free when checked (view_account → UNKNOWN_ACCOUNT, 2026-10-22). Fallbacks if
`yeetpad.near` gets taken: `yeetpadfun.near`, `yeetpad-fun.near` (`--root=<name>`; also update the ids below).
`yeetpad.near` is created through the `near` registrar contract (`near.create_account`); the attached NEAR
becomes its balance, nothing is charged beyond its own storage (~0.0018 NEAR).

## Budget (from the dry run; storage 1e19 yocto/byte on mainnet, protocol 86)

| Item | NEAR |
|---|---|
| factory.yeetpad.near: code 379,000 B + state + 0.1 buffer (locked) | 3.898 |
| global token code 166,503 B × 10 (burned, NEP-591) + gas | 16.653 |
| vault.yeetpad.near: code 256,189 B + state + 0.2 buffer (locked) | 2.774 |
| yeetpad.near: account + Rhea DCL storage 0.5 + 0.2 buffer | 0.714 |
| relayer.yeetpad.near: account + 1 NEAR gas float | 1.002 |
| tx gas | 0.023 |
| left on deployer | 0.010 |
| **Total** | **25.073** |

Without the global token (`--no-global`) the total is 8.42 NEAR, but every launch then costs creators ~1.82 NEAR
instead of ~0.076 (break-even ≈ 10 launches). Test launches after deploy (from your own wallet as a creator):
Rhea ~0.12, Nearly ~0.3, JustHoot ~0.05 + generation credits.

## Steps

1. **Fund** the deployer implicit account (≥ 25.1 NEAR; 30 planned). Check: `bun run deploy:mainnet` shows the balance.
2. **Build contracts** (only if contracts changed): `bun run contracts:build`; token sha256 must be
   `3LwjqsJaFSGkMRKoV3vGCN74bTMH6KTgwTbfxc5cHTmW` (the factory only accepts the hash of its embedded wasm).
3. **Deploy on-chain**: `bun run deploy:mainnet -- --execute`. It does, in order: create `yeetpad.near` and fund it;
   create factory/vault/relayer sub-accounts; deploy + init factory (owner `yeetpad.near`); deploy + init vault
   (owner `yeetpad.near`, factory, relayer `relayer.yeetpad.near`, fee 0; DCL/wNEAR default to
   `dclv2.ref-labs.near`/`wrap.near`); `publish_global_token` + `set_global_token`; register the vault on Rhea DCL (0.5).
   Verify: `factory.get_config` shows `global_token`, `get_required_deposit` ≈ 0.076 NEAR.
4. **Admin account**: put your own mainnet wallet in `ADMIN_ACCOUNTS` (env.mainnet in
   `apps/orchestrator-api/wrangler.jsonc`), keep `LOCKED=1`.
5. **API secrets** (worker `one-shot-launchpad-api-mainnet`; values come from files, never echo them):
   ```sh
   cd apps/orchestrator-api
   jq -r .private_key ~/.secrets/near_mainnet_relayer_yeetpad.json | npx wrangler secret put RELAYER_PRIVATE_KEY --env mainnet
   npx wrangler secret put SESSION_SECRET --env mainnet < ~/.secrets/yeetpad_mainnet_session_secret
   npx wrangler secret put NEARAI_API_KEY --env mainnet   # same LLM key as testnet
   ```
6. **Deploy the mainnet API**: `CLOUDFLARE_ACCOUNT_ID=… bun run deploy:api:mainnet`;
   check `GET /api/health` (network `mainnet`, venues: rhea on, nearly/justhoot off).
   KV: separate namespace `yeetpad-sites-mainnet` (`1370f80509d14b8897360a7d4dc18b01`), already created.
7. **Deploy the mainnet site** to workers.dev: `bun run deploy:web:mainnet` (builds with `PUBLIC_NETWORK=mainnet`,
   deploys worker `one-shot-launchpad-mainnet`, then rebuilds the testnet dist). Check
   https://one-shot-launchpad-mainnet.sushmitsarmah.workers.dev: mainnet pill/copy, wallet asks for `vault.yeetpad.near`.
8. **First tiny Rhea listing** from your wallet: deposit ~0.15 NEAR credits, generate one idea, launch with
   "List on Rhea" at a small FDV. Verify: token on nearblocks.io, pool on app.rhea.finance (the pool link format
   `https://app.rhea.finance/poolV2/<token>@wrap.near@10000` is unverified on mainnet; fix `RHEA_POOL_URL_BASE`
   if it 404s), LP NFT owned by your wallet, vault holds 0 tokens.
9. **Enable Nearly, then JustHoot**, one at a time: set `NEARLY_ENABLED=1` → deploy API → one tiny launch →
   verify the token page link. Then `JUSTHOOT_ENABLED=1` → deploy → one tiny launch (check that JustHoot accepts our
   `reference` URL and the icon; `JUSTHOOT_REFERENCE=0` if not).
10. **Domain flip** (when happy), in Cloudflare → Workers → Domains:
    - `yeetpad.fun` + `www.yeetpad.fun` → `one-shot-launchpad-mainnet`
    - `testnet.yeetpad.fun` → `one-shot-launchpad` (testnet). Then set testnet `SITE_ORIGIN`/`PUBLIC_SITE_URL`/
      `SITE_BASE` to `https://testnet.yeetpad.fun`, add it to the testnet API `CORS_ORIGINS`, and push.
    - Point the mainnet `PUBLIC_API_URL` at a custom API domain later if wanted (`api.yeetpad.fun`).
11. **Workers Builds** keeps deploying the testnet site on push to main. Mainnet site deploys are manual
    (step 7) until the flip; afterwards add a second Workers Build with deploy command
    `npx wrangler deploy --env mainnet` and build command `bun install && bun run build:web:mainnet`.

## Config switches (reference)

- API: `NEAR_NETWORK=mainnet` flips all defaults (RPC, explorer, DCL, wNEAR, Rhea/Nearly URLs, vault/factory ids,
  auth recipient); every value is still overridable by its own var.
- Site: `PUBLIC_NETWORK=mainnet` flips API URL, vault id, RPC, explorer and the copy (pill, hero, FAQ, footer,
  token-page footer). `PUBLIC_SITE_URL` sets canonical URLs; the site worker's `SITE_ORIGIN` sets token-page canonicals.
- Ops: pause either contract with `set_paused(true)` from `yeetpad.near`; upgrade with `update_contract` (owner,
  new wasm as input), same as on testnet.

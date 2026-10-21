# Yeetpad (NEAR testnet)

https://yeetpad.fun · repo, package and Worker names still use `one_shot_launchpad` / `one-shot-launchpad`.

Land → connect a NEAR wallet → deposit NEAR as NEAR AI credits → generate a token/site idea with an LLM → launch a NEP-141 token owned by you. **Testnet only.**

## Architecture

```
 browser (Astro static + React island)                 NEAR testnet
 ┌──────────────────────────────┐   deposit_credits   ┌─────────────────────────┐
 │ apps/studio-web              │ ──────(wallet)────▶ │ near-launch-vault       │
 │  wallet-selector + modal     │   get_balance (RPC) │  user_balances, relayers│
 │  Top up / Generate / Launch  │ ◀────────────────── │  treasury, fee bps      │
 └──────────────┬───────────────┘                     └──────┬──────────────────┘
                │ POST /api/generate, /api/launch            │ create_token (+deposit)
                ▼                                            ▼
 ┌──────────────────────────────┐ deduct_ai_compute   ┌─────────────────────────┐
 │ apps/orchestrator-api (Hono) │ execute_sponsored_  │ near-ft-factory         │
 │  relayer key (env)           │ launch ───────────▶ │  creates <ticker>.<fac> │
 │  NEAR AI Cloud (OpenAI API)  │                     │  deploys NEP-141 wasm,  │
 └──────────────────────────────┘                     │  mints supply to user   │
                                                      └─────────────────────────┘
```

* **Generate**: API checks the user's vault balance ≥ `AI_COMPUTE_COST_YOCTO`, calls the LLM with a JSON schema, validates with zod, and only then the relayer calls `deduct_ai_compute`.
* **Batch launch** (`POST /api/launch/batch`, 1-5 ideas): one `execute_sponsored_launch_batch` tx; the vault debits the whole batch up front, runs one detached factory call per item, and refunds each failed item on its own (results come from NEP-297 events). `/api/generate` takes `count` (1-5) and charges `count × AI_COMPUTE_COST_YOCTO` once.
* **Token sites**: at launch the API writes the SiteConfig to Workers KV (`SITES` binding, namespace `yeetpad-sites`, key `site:<ticker>`) and a compact copy (≤2 KiB) goes on-chain in the factory record. `GET /api/site/:ticker` reads KV, falling back to the on-chain record; the static page `/t/` renders it, and `public/_redirects` (`/t/:ticker → /t/ 200`) makes every `/t/<ticker>` serve that page. `GET /api/launches/:account` lists a creator's tokens (factory `get_tokens_by_owner`) for "My launches" on `/app/`.
* **Creator analytics + views**: token pages never carry Yeetpad's GA (that is only on the landing page). A token's creator can set their own GA4 id with `PUT /api/site/:id/settings` (`{ "gaId": "G-XXXX" | null }`; NEP-413 session; only the site's `ownerWallet`, others get 403). It is stored as `analytics.gaId` in the SiteConfig, validated against `^G-[A-Z0-9]{4,12}$`, and the frontend Worker injects the gtag snippet server-side only for a valid id, plus a footer note "This page may use the creator's analytics". The frontend Worker also counts first-party views (`views:<ticker>` in KV, no cookies, bots/prefetch skipped, written via `waitUntil`); `/api/site/:id` and `/api/launches/:account` return `views`. KV is eventually consistent (reads cached ~60 s, read-modify-write can drop concurrent hits), so counts are approximate and settings can take up to a minute to show on the page.
* **Launch**: API checks the ticker is free and the balance covers the factory's `get_required_deposit`, then the relayer calls `execute_sponsored_launch`. The vault debits the user, calls `create_token` on the factory with the deposit, and its callback **refunds the user** if anything fails (factory panic or sub-account creation failure).

```
apps/
  studio-web/          Astro (static): landing page at /, studio (React island) at /app/
  orchestrator-api/    Bun + Hono API (also a Cloudflare Worker): /api/auth/session, /api/generate,
                       /api/launch, /api/launch/batch, /api/site/:ticker, /api/launches/:account,
                       /api/balance/:account, /api/health
packages/
  schema/              zod: LaunchIdea, SiteConfig, API request/response types, NEAR helpers
contracts/
  near-ft-token/       NEP-141 (+NEP-145/148) via near-contract-standards; full supply → owner
  near-ft-factory/     v0.2: create_token(ticker, metadata, total_supply, owner_id, site?); embeds token
                       wasm; token registry + paginated views, NEP-297 events, pause/2-step owner/upgrade
  near-launch-vault/   v0.2: credits vault: deposit / deduct / sponsored launch (single + batch ≤5) /
                       withdraw / relayers; NEP-297 events, storage accounting, pause/owner/upgrade
  integration-tests/   near-workspaces sandbox tests (separate cargo workspace)
  build-contracts.sh   token → factory/res → factory, vault; outputs contracts/res/*.wasm
scripts/               Bun deploy + init scripts for testnet
```

### Contract API (vault)

| method | who | notes |
|---|---|---|
| `new(owner_id, ft_factory, platform_fee_bps?, relayers?)` | init | |
| `deposit_credits()` `#[payable]` | anyone | emits NEP-297 `launch_vault/deposit_credits` |
| `withdraw_unused(amount)` | user | transfers back unused credits |
| `deduct_ai_compute(user_id, amount)` | relayer | moves amount to treasury |
| `execute_sponsored_launch(user_id, token, deposit_required) -> Promise` | relayer | debits deposit + fee, refunds on failure |
| `execute_sponsored_launch_batch(user_id, tokens, deposit_required) -> u32` | relayer | 1-5 tokens, unique valid tickers; per-item refund on failure |
| `set_paused` / `propose_owner` / `accept_owner` / `update_contract` (+`migrate`) | owner | paused blocks deposits/launches, never `withdraw_unused` |
| `add_relayer` / `remove_relayer` / `set_platform_fee_bps` / `set_ft_factory` / `withdraw_treasury` | owner | |
| `get_balance(account_id)`, `get_relayers()`, `get_config()` | view | |

Factory views: `get_token(ticker)`, `get_tokens(from_index, limit≤50)`, `get_tokens_by_owner(owner_id, from_index, limit)`, `is_ticker_taken`, `get_required_deposit`, `get_config`. Events use standards `yeetpad_vault` and `yeetpad_factory`.

`token` = `{ ticker, name, symbol?, icon?, decimals?, total_supply, site? }`. Tickers: 2–16 chars, `a-z0-9`, starting with a letter (validated in the factory and in `packages/schema`). All balance math uses checked add/sub/mul.

## Prerequisites

* [Bun](https://bun.sh) ≥ 1.2 (developed with 1.4.2)
* Rust stable ≥ 1.93 (near-sdk 5.29 MSRV) with `wasm32-unknown-unknown`, plus [`cargo-near`](https://github.com/near/cargo-near) (`cargo-near` 0.22 used). Without cargo-near the build script falls back to `cargo build --target wasm32-unknown-unknown --release`.
* Linux: `pkg-config libssl-dev` for the integration tests.

```bash
bun install
```

## Build & test

```bash
bun run contracts:build      # -> contracts/res/{near_ft_token,near_ft_factory,near_launch_vault}.wasm
cargo test --workspace       # contract unit tests
cd contracts/integration-tests && cargo test   # near-workspaces sandbox (downloads near-sandbox once)
bun run test:api             # API tests in mock mode
bun run typecheck
```

The factory embeds the token wasm via `include_bytes!`, so `contracts:build` (or at least the token build) must run before compiling the factory. Integration tests read the wasm from `contracts/res/`.

## Run locally

```bash
cp apps/orchestrator-api/.env.example apps/orchestrator-api/.env   # LLM_MOCK=1, NEAR_MOCK=1 by default
bun run dev:api                                                    # http://localhost:8787

cp apps/studio-web/.env.example apps/studio-web/.env
bun run dev:web                                                    # http://localhost:4321
```

Smoke test the API (public endpoints; `/api/generate` and `/api/launch` need a session, see [Auth](#auth-nep-413-sign-in--session)):

```bash
curl -s localhost:8787/api/health
curl -s localhost:8787/api/balance/alice.testnet
```

Routes in the web app: `/` is the landing page, `/app/` is the studio (wallet connect, top-up, generate, launch). `/app` redirects to `/app/` on Cloudflare.

* `LLM_MOCK=1` returns a deterministic idea without calling NEAR AI.
* `NEAR_MOCK=1` uses an in-memory ledger (every account starts at 10 NEAR) instead of testnet, so no relayer key is needed. The web app's balance display always reads the real vault via RPC.

## Environment variables

### `apps/orchestrator-api/.env`

| var | default | |
|---|---|---|
| `PORT` | `8787` | |
| `CORS_ORIGINS` | `*` | comma-separated origins, e.g. your Pages URL |
| `NEARAI_BASE_URL` | `https://cloud-api.near.ai/v1` | NEAR AI Cloud gateway (OpenAI-compatible) |
| `NEARAI_MODEL` | `z-ai/glm-5.3-flash` | any id from `GET https://cloud-api.near.ai/v1/models` |
| `NEARAI_API_KEY` | – | from https://cloud.near.ai (API Keys) |
| `LLM_MOCK` | off | `1` = no LLM call |
| `NEAR_MOCK` | off | `1` = no chain calls |
| `NEAR_RPC_URL` | `https://test.rpc.fastnear.com` | |
| `VAULT_CONTRACT` | `launch-vault.testnet` | vault account id |
| `FT_FACTORY_CONTRACT` | `ft-factory.testnet` | factory account id |
| `RELAYER_ACCOUNT_ID` / `RELAYER_PRIVATE_KEY` | – | relayer must be in `get_relayers()`; key `ed25519:...` |
| `AI_COMPUTE_COST_YOCTO` | `1e22` (0.01 NEAR) | charged per successful generation |
| `TOKEN_TOTAL_SUPPLY` / `TOKEN_DECIMALS` | `1e27` / `18` | 1B tokens |
| `EXPLORER_BASE` | `https://testnet.nearblocks.io` | |
| `SESSION_SECRET` | random per process | HMAC key for session tokens; **set it** (secret) in any shared deployment |
| `AUTH_RECIPIENT` | `VAULT_CONTRACT` | NEP-413 `recipient` the sign-in must be addressed to (the web app uses the vault id) |

### `apps/studio-web/.env` (build-time, `PUBLIC_*`)

| var | |
|---|---|
| `PUBLIC_API_URL` | orchestrator base URL, e.g. `https://api.example.com` |
| `PUBLIC_VAULT_CONTRACT` | vault account id |
| `PUBLIC_NEAR_RPC_URL` | optional, default `https://test.rpc.fastnear.com` |

### `scripts/.env`

`NEAR_ACCOUNT_ID` (parent `*.testnet`), `NEAR_PRIVATE_KEY`, optional `FT_FACTORY_ACCOUNT_ID`, `VAULT_ACCOUNT_ID`, `RELAYER_ACCOUNT_ID`, `PLATFORM_FEE_BPS`, `FACTORY_INITIAL_BALANCE` (5), `VAULT_INITIAL_BALANCE` (3).

Never commit real `.env` files; only `.env.example` is tracked.

## Auth (NEP-413 sign-in → session)

`/api/generate` and `/api/launch` require `Authorization: Bearer <session>`; the account is taken from the session (an `ownerWallet` in the body must match it or the API answers 403). `/api/health`, `/api/balance/:account` and `/api/auth/session` are public.

1. The studio asks the connected wallet to `signMessage` (NEP-413) once per session, with a random 32-byte nonce, `recipient` = the vault contract id and the message
   `Sign in to Yeetpad\naccount: <id>\nissued: <ISO time>` (the old "One Shot Launchpad" title is still accepted). Signing is free (no transaction).
2. `POST /api/auth/session` with `{accountId, publicKey, signature, message, nonce, recipient, callbackUrl}`. The API rebuilds the NEP-413 payload (borsh: `u32 2147484061` tag, then `message`, `nonce[32]`, `recipient`, `Option<callbackUrl>`), sha256s it and verifies the ed25519 signature (with and without `callbackUrl`, since wallets differ). It then checks the message account matches, `issued` is at most 10 minutes old (1 minute of clock skew allowed), the recipient is `AUTH_RECIPIENT`, the nonce wasn't used before (best-effort in-memory cache), and, unless `NEAR_MOCK=1`, that the key is a **FullAccess** key of the account (`view_access_key`).
3. It returns an HMAC-SHA256 token (`base64url(json{sub,exp}).base64url(mac)`, keyed by `SESSION_SECRET`) valid for 24h. The studio keeps it in `localStorage` and clears it on sign-out, account change or a 401.

Inline wallets (Meteor, HERE, the MyNearWallet popup) return the signature directly. For redirect-style wallets the pending request is kept in `localStorage`, and on return to `/app/` the studio reads `accountId`/`publicKey`/`signature` (or `error`) from the URL hash or query, finishes the exchange and strips them from the URL.

Tests: `src/auth.test.ts` (signatures built with near-api-js's own NEP-413 signer: valid, wrong account, wrong recipient, stale/future timestamp, tampered message/nonce, other key, non-full-access key, replay, token forgery/expiry) and `src/app.test.ts` (401/403 paths in mock mode).

## NEAR AI

Uses the NEAR AI Cloud gateway, OpenAI-compatible: `POST https://cloud-api.near.ai/v1/chat/completions` with `Authorization: Bearer $NEARAI_API_KEY` ([quickstart](https://docs.near.ai/cloud/quickstart), [OpenAI compatibility](https://github.com/nearai/docs/blob/main/docs/cloud/guides/openai-compatibility.mdx), [API reference](https://docs.near.ai/api-reference/chat/create-chat-completion)). The client asks for `response_format: json_schema` (generated from the zod schema); if a model rejects that, it retries with `json_object`. The output is always validated with zod.

## Deploy contracts (testnet)

```bash
bun run contracts:build
cp scripts/.env.example scripts/.env   # fill NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY
bun run deploy:factory                 # creates/deploys/inits ft-factory.<you>.testnet
bun run deploy:vault                   # creates/deploys/inits launch-vault.<you>.testnet with relayer + factory
```

Upgrade in place (keeps state and addresses; runs `migrate`): `bun run contracts:upgrade`. Testnet is on v0.2.0.

Sub-accounts are created with the parent's public key. Re-running redeploys code (state kept) and, for the vault, ensures the relayer is registered. Each token launch needs roughly 1.8 NEAR of storage (see factory `get_required_deposit`), so users should top up ~2+ NEAR.

## Cloudflare deploy

Live (testnet): frontend https://yeetpad.fun (custom domain, once attached) and https://one-shot-launchpad.sushmitsarmah.workers.dev, API https://one-shot-launchpad-api.sushmitsarmah.workers.dev

### Frontend (studio-web): Workers static assets via Workers Builds

The root `wrangler.jsonc` (Worker `one-shot-launchpad`, assets only, serves `apps/studio-web/dist`) is deployed by Cloudflare Workers Builds on every push to `main`:

| setting | value |
|---|---|
| Build command | `bun install && bun run build:web` |
| Deploy command | `npx wrangler deploy` (repo root) |
| Env vars | optional `PUBLIC_API_URL`, `PUBLIC_VAULT_CONTRACT`, `PUBLIC_NEAR_RPC_URL` |

The build runs Astro under the Bun runtime (`bun --bun astro build`), so the Node version on the build image doesn't matter. The output is fully static (React island, `client:only`). If the `PUBLIC_*` vars are unset, `apps/studio-web/src/lib/config.ts` falls back to the deployed testnet API, `launch-vault.osl-launchpad-5786.testnet` and `https://test.rpc.fastnear.com`.

### API (orchestrator-api): Cloudflare Worker

`apps/orchestrator-api/wrangler.jsonc` (Worker `one-shot-launchpad-api`, entry `src/worker.ts`, `nodejs_compat`, `workers_dev: true`). Non-secret config is in its `vars`; on the first request the Worker reads its env bindings into `config` (`configureFromEnv`), so nothing depends on `process.env` at module load. The Bun server (`src/index.ts`, `bun run dev:api`) still reads `apps/orchestrator-api/.env`.

```bash
cd apps/orchestrator-api
npx -y wrangler@4.86.0 dev                  # local Worker on :8787; reads secrets from .env / .dev.vars (gitignored)
npx -y wrangler@4.86.0 deploy               # or: bun run deploy:api from the repo root
# one-time secrets (pipe values in; never commit or echo them)
printf '%s' "$NEARAI_API_KEY"      | npx -y wrangler@4.86.0 secret put NEARAI_API_KEY
printf '%s' "$RELAYER_PRIVATE_KEY" | npx -y wrangler@4.86.0 secret put RELAYER_PRIVATE_KEY
openssl rand -hex 32               | npx -y wrangler@4.86.0 secret put SESSION_SECRET   # rotating it logs everyone out
```

Wrangler is pinned to 4.86.0 because newer 4.x releases need Node 22 (the box has Node 20); with Node 22+ any 4.x works. `bun run deploy:api` needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.

Token sites need the KV namespace (`wrangler kv namespace create yeetpad-sites`; its id is in `kv_namespaces` in `apps/orchestrator-api/wrangler.jsonc`). The API token needs **Workers KV Storage: Edit** for that one-time create; `SITE_BASE` sets the public site URL (`https://yeetpad.fun`). Outside Workers (Bun dev, tests) an in-memory store is used.

A token with **Account > Workers Scripts: Edit** is enough (set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). The API is not deployed by Workers Builds; redeploy it with the command above after API changes. Keep `CORS_ORIGINS` in `vars` in sync with the frontend origins (currently `https://yeetpad.fun`, `https://www.yeetpad.fun`, the workers.dev URL and `http://localhost:4321`). The NEP-413 recipient is the vault id, not the origin, so adding a domain needs no auth change.

## Known limitations / later

* **Sessions are stateless**: a token can't be revoked before it expires (24h) except by rotating `SESSION_SECRET`. The nonce replay cache is per Worker isolate; the 10-minute freshness window is the main replay guard.
* Custom domains and the Solana path are out of scope here.
* **Liquidity (mainnet note)**: `buyUrl` points at the token's nearblocks page; there is no testnet DEX route. NEAR Intents / 1Click has no testnet deployment (per its docs) and Shore is mainnet-only. Meme.Cooking has a testnet factory (`factory.v10.meme-cooking.testnet`), but it mints its own token through an auction that its operator finalizes; it can't add liquidity to a token from our factory. On mainnet the path is: launch, then create a Rhea (Ref) pool or hand off to Shore/Meme.Cooking, and quote buys via 1Click.

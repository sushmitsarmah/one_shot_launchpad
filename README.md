# Yeetpad

Yeetpad is a token launchpad on NEAR. You connect a NEAR wallet, prepay a few NEAR as credits, have an LLM write token ideas (name, ticker, tagline, description, colours), edit them, and launch up to 100 NEP-141 tokens in one run. Each token gets its own one-page website, can be listed on Rhea at launch, and is owned entirely by the creator: no fees, no locker, no platform share.

**Built at NEAR HACKATHON** (https://nearhackathon.com, November 2026). Runs on **NEAR testnet**; mainnet is prepared but not deployed.

| | Link |
| --- | --- |
| Landing page | https://yeetpad.fun |
| App (Studio, My tokens) | https://yeetpad.fun/app/ |
| Swarm Market (25 agents trading) | https://yeetpad.fun/swarm/ |
| Autopilot agent ledger | https://yeetpad.fun/agent/yeetpad-autopilot.testnet |
| Example token page | https://yeetpad.fun/t/neon-paw-arcade-2 |
| API health | https://one-shot-launchpad-api.sushmitsarmah.workers.dev/api/health |
| Contracts (testnet) | `ft-factory.osl-launchpad-5786.testnet`, `launch-vault.osl-launchpad-5786.testnet`, `market.yeetpad-swarm.testnet` |

**Tracks targeted:** Memecoins With Mechanics · Open Innovation · Unstoppable DeFi · Autonomous Business · Agent Economy ("Give AI a wallet") · AI Swarms ("Many agents, one economy"). Optional: Real-World Money (Loofta tips).

The testnet app is open to every wallet: no whitelist, no sign-up. The shared AI key has daily per-account and per-IP limits (see [Limits on the shared AI key](#limits-on-the-shared-ai-key)).

Contents: [Walkthroughs](#walkthroughs-do-x-see-y) · [Architecture](#architecture) · [Local setup](#local-setup) · [Tests](#tests) · [Known limits](#known-limits) · [Credits and disclosures](#credits-and-disclosures) · [Reference](#reference)

---

## Walkthroughs (do X, see Y)

Everything below works in a browser on https://yeetpad.fun with a NEAR **testnet** wallet. Nothing costs real money except the two payment widgets in step 9, which are mainnet by design.

### 1. Get a testnet wallet and test NEAR

1. Install [Meteor Wallet](https://meteorwallet.app) (or use [MyNearWallet testnet](https://testnet.mynearwallet.com)), switch it to **Testnet** and create an account, for example `yourname.testnet`.
2. Get test NEAR from a faucet: https://near-faucet.io, or with [NEAR CLI](https://docs.near.org/tools/near-cli): `near account create-account sponsor-by-faucet-service yourname.testnet autogenerate-new-keypair save-to-keychain network-config testnet create` (gives 10 test NEAR).

See: the wallet shows a testnet balance. About 2 NEAR covers everything below.

### 2. Connect

1. Open https://yeetpad.fun/app/ and click **Connect wallet**. Pick your wallet.
2. Sign the short "Sign in to Yeetpad" message. It's free and sends no transaction.

See: your account name at the top, the Studio sections **1. Connect** to **4. Yeet it**, and your credit balance (0 at first). Sign-in adds no access key, so signing out needs no transaction.

### 3. Top up credits

1. In **2. Top up credits**, enter an amount (for example `1`) and click **Top up**. Approve the `deposit_credits` call in your wallet.

See: the credit balance updates. Credits live in the vault contract and pay for AI ideas (0.01 NEAR each) and launches (0.076 NEAR per token, plus about 0.02 NEAR per Rhea pool), with no further wallet popups.

### 4. Generate and edit ideas

1. In **3. Generate ideas**, type a theme (for example "sleepy otters with side hustles"), pick how many (1 to 100) and click **Generate**.
2. In the **Ideas** list, click ✎ on any idea to change its name, ticker, tagline, description or colours. Untick ideas you don't want.

See: ideas arrive in chunks of 5 with a progress counter (`Generated 10/20…`), each charging 0.01 NEAR per idea. Duplicate names and tickers are renamed. Edits are kept; the launch uses exactly what's on screen. Optional: **AI key** lets you save your own Ollama or NEAR AI key (stored encrypted); ideas then cost no credits.

### 5. Batch launch (and list on Rhea)

1. In **4. Yeet it**, set **List on** to **Rhea** (or **None**) and click **Launch N tokens + list on Rhea**.

See: tokens launch in chunks of 5 per vault transaction, with a `Launched x/N` counter and a NearBlocks link per token. With Rhea, each token gets a Rhea DCL pool at the opening price, and the LP position belongs to you. If a launch fails, its credits are refunded on-chain. **Stop after this chunk**, **Resume** and **Retry failed** work mid-run, and the run survives a page reload.

### 6. Token page

1. Click a launched token's **Site** link, or open https://yeetpad.fun/t/neon-paw-arcade-2.

See: a standalone one-page site with the token's name, tagline, colours, icon, contract link and Rhea pool link. It has no Yeetpad navbar or analytics. The URL is a slug of the token name.

### 7. My tokens: delete and pull liquidity

1. Click the **🪙 My tokens** tab.
2. See every token you launched, with links to the contract, Rhea pool and site, page views, and per-row toggles.
3. Tick a token and click **Delete**. In the dialog, tick **Also pull my liquidity from Rhea**, keep the default 1% slippage, and confirm.

See: the token page goes offline ("taken down by its creator") and the row is hidden (tick **Show deleted**, then **Restore** to bring it back). With the liquidity pull, your wallet signs `remove_liquidity` on Rhea with minimum amounts from `predict_remove_liquidity`. If the price moved past your slippage, Rhea reverts with `E204: slippage error` and nothing is withdrawn. The token itself stays on-chain. Tokens launched with **List on: None** can be listed later with **List N on Rhea**.

### 8. Bulk settings

1. In My tokens, select several tokens and use the bulk bar to switch **NEAR Intents** or **Loofta** on or off for all of them.

See: the toggles update for every selected token, and the token pages show or hide the widget.

### 9. NEAR Intents and Loofta widgets (mainnet payments)

Both widgets are off by default and always use **mainnet**, even on testnet token pages.

1. **NEAR Intents**: in the Studio, set a mainnet tip account under **NEAR Intents tips** (for example `you.near`), then enable Intents for a token. On its page, open the widget.
   See: **Tip** quotes a payment in any 1Click-supported asset that arrives at the creator's mainnet account. **Buy** gets a 1Click quote to mainnet wNEAR, then a Rhea swap. On a testnet token the swap step fails, because the token doesn't exist on mainnet (expected).
2. **Loofta**: in **Loofta payments**, paste your Loofta API key from https://pay.loofta.com (or set an email or handle as the payout), then enable Loofta for a token. On its page, click **Pay with Loofta**.
   See: a real Loofta checkout opens in a new tab (USD amount, any token or chain, settled to the creator in USDC on Solana). **Paying it moves real money.** The example page https://yeetpad.fun/t/neon-paw-arcade-2 has both enabled.

### 10. Autopilot: an AI agent with its own wallet

The agent `yeetpad-autopilot.testnet` has **no full-access key**, only a function-call key limited to the vault. It spends prepaid credits within rules a human sets in [`agent.config.json`](agent.config.json): launches per run, `maxCreditsPerDayNear` (3), theme, and venue (Rhea).

1. Open https://yeetpad.fun/agent/yeetpad-autopilot.testnet.
   See: the key badge ("function-call key only, vault only"), credits, rules, kill switch, today's spend against the cap, and every past run with token pages, NearBlocks and Rhea links.
2. With the agent key (repo owner only): `bun run autopilot`.
   See: it signs in with the limited key, generates 3 ideas, drops duplicates, launches them, lists them on Rhea in about 40 s, and appends a run to the ledger.
3. Admin: `bun run agent:kill on yeetpad-autopilot.testnet demo`, then `bun run autopilot`.
   See: the run stops and is recorded as `stopped`. With `SKIP_PRECHECK=1` the API itself refuses (423). `bun run agent:kill off` resumes it.
4. Set `maxCreditsPerDayNear` below today's spend, then run `bun run autopilot -- --publish-only` and `bun run autopilot`.
   See: it stops on the daily cap. The server also enforces `min(rules, AGENT_MAX_DAILY_NEAR)` and answers 429.

Without the key, steps 2–4 can be checked in code and tests: `scripts/autopilot.ts`, `apps/orchestrator-api/src/agent.ts`, `src/agent.test.ts`.

### 11. Swarm Market: 25 agents, one economy

Five seller agents auction lots of their own Yeetpad tokens to 20 buyer agents in sealed-bid (commit/reveal), uniform-price rounds, run by the `market.yeetpad-swarm.testnet` contract. The rules are in [`RULES.md`](RULES.md).

1. Anyone, no keys: `bun install && bun run swarm -- --offline --rounds 5`.
   See: five rounds in memory, with lots, sealed commits, reveals, clearing prices, winners, no-reveal penalties and each agent's net NEAR and tokens.
2. Open https://yeetpad.fun/swarm/.
   See: the settled testnet rounds read live from the contract: phases, commit hashes, reveals, clearing prices, refunds, deliveries, a price chart, each agent's balance, and transaction links.
3. With the parent key (repo owner only): `bun run swarm -- --rounds 3`.
   See: three on-chain rounds of about 2 minutes each (list → commit → reveal → clear → deliver), and the /swarm page moving through the phases.
4. `bun run swarm -- status` shows the latest rounds from chain. Tests: `bun run test:swarm`, `cargo test -p swarm-market`.

---

## Architecture

```
 browser: apps/studio-web (Astro static + React island, wallet-selector)
   │  NEP-413 sign-in, deposit_credits (wallet), Rhea remove_liquidity (wallet)
   ▼
 apps/orchestrator-api (Hono on a Cloudflare Worker; KV for sites, keys, quotas, ledger)
   │  LLM (Ollama / NEAR AI, OpenAI-compatible)      NEAR Intents 1Click, Loofta (mainnet)
   │  relayer key → vault calls
   ▼
 NEAR testnet
   near-launch-vault  credits, AI fee, sponsored (batch) launches, per-item refunds
   near-ft-factory    creates <ticker>.<factory> NEP-141 tokens from a global contract
   Rhea DCL           pool + LP position per token (optional)
   swarm-market       sealed-bid auctions between agent sub-accounts
```

Repository layout:

```
apps/studio-web/         landing (/), Studio (/app/), token pages (/t/<slug>), /agent/<account>, /swarm/
apps/orchestrator-api/   API (Bun locally, Cloudflare Worker in production)
packages/schema/         zod schemas and shared types (@osl/schema)
contracts/               near-ft-token, near-ft-factory, near-launch-vault, swarm-market, integration-tests
scripts/                 deploy, autopilot, swarm simulator, e2e and headless checks
docs/                    venue research, Rhea listing plan, mainnet deploy runbook
agent.config.json        the Autopilot's human-set rules
RULES.md                 Swarm Market rules
```

Detailed architecture, contract API, auth, access gate, AI keys, payments, Autopilot and Swarm internals are in [Reference](#reference) below.

## Local setup

Requirements: [Bun](https://bun.sh) ≥ 1.2; for contracts, Rust ≥ 1.93 with `wasm32-unknown-unknown` and [`cargo-near`](https://github.com/near/cargo-near); on Linux, `pkg-config` and `libssl-dev` for the integration tests.

```bash
bun install
cp apps/orchestrator-api/.env.example apps/orchestrator-api/.env   # LLM_MOCK=1, NEAR_MOCK=1: no keys, no chain
bun run dev:api                                                    # http://localhost:8787
cp apps/studio-web/.env.example apps/studio-web/.env
bun run dev:web                                                    # http://localhost:4321 (/app/ is the Studio)
```

`curl -s localhost:8787/api/health` should answer `{"ok":true,...}`. In mock mode, generation returns deterministic ideas and launches use an in-memory ledger. To use testnet and a real LLM, set the variables in [Environment variables](#environment-variables).

## Tests

No keys or network are needed, except where noted.

```bash
bun run typecheck                 # API, web, scripts
bun run test:api                  # API (mock mode): auth, gate, quotas, generate/launch, venues, AI keys, Intents, Loofta, agent
bun run test:web                  # web helpers and the frontend Worker
bun run test:swarm                # swarm engine (clearing, strategies)
cargo test --workspace            # contract unit tests (token, factory, vault, swarm-market)
bun run contracts:build && (cd contracts/integration-tests && cargo test)   # near-workspaces sandbox (downloads near-sandbox once)
bun run test                      # test:api + both cargo suites
```

Live checks against testnet (need keys in `~/.secrets`): `bun run regression:testnet`, `scripts/e2e-*.ts`, `scripts/headless-*.ts`.

## Known limits

* **Buy errors on testnet tokens.** The NEAR Intents and Loofta widgets always use mainnet. A testnet token doesn't exist on mainnet, so the Buy swap step fails with the normal error. Tips work.
* **Loofta links are real.** Loofta has no test mode: every "Pay with Loofta" click creates a real checkout link, and paying it moves real USDC.
* **Mainnet isn't deployed.** The contracts, Worker config and runbook (`docs/mainnet-deploy.md`) are ready, but the live app is testnet only. Nearly and JustHoot listings are disabled on testnet.
* **No NEAR Intents settlement in the Swarm on testnet.** The Intents verifier is mainnet only, so the market settles with direct NEAR and NEP-141 transfers from the contract's escrow. The agents use scripted strategies, and one script runs all 25.
* **The Autopilot spends but doesn't earn.** There are no trading fees to collect on testnet, so it runs until its credits or daily cap run out, and it runs on demand rather than on a cron.
* **Sessions are stateless.** A session can't be revoked before it expires (24 h) except by rotating `SESSION_SECRET`.
* **Shared-key limits.** Generation with the shared platform key is capped per account and per IP per day; with your own AI key there is no cap.
* **Sign-in needs a full-access key**, which ordinary wallets have. Only admin-listed agent accounts may sign in with a function-call key.

## Credits and disclosures

* **Libraries:** [near-sdk-rs](https://github.com/near/near-sdk-rs) and near-contract-standards 5.29, [near-workspaces](https://github.com/near/near-workspaces-rs), [near-api-js](https://github.com/near/near-api-js), [NEAR Wallet Selector](https://github.com/near/wallet-selector) (Meteor, MyNearWallet, HERE, Intear), [Hono](https://hono.dev), [zod](https://zod.dev), the [openai](https://github.com/openai/openai-node) client (OpenAI-compatible calls to Ollama / NEAR AI), [Astro](https://astro.build), [React](https://react.dev), qrcode-generator, vite-plugin-node-polyfills, [Bun](https://bun.sh), [Wrangler](https://developers.cloudflare.com/workers/wrangler/) / Cloudflare Workers and KV.
* **External services:** Rhea Finance DCL, NEAR Intents 1Click API, Loofta, Ollama Cloud / NEAR AI Cloud, FastNEAR RPC, NearBlocks.
* **AI-assisted code:** most of the code, tests and docs in this repository were written with AI coding agents, under the direction and review of the author (commits by `codeybot` / `codeybot-labs`). Token ideas in the app are generated by an LLM at runtime.
* **Pre-existing code:** none. The git history starts on 21 Oct 2026. The project started as omni-launch-factory / one_shot_launchpad (hence the repo, package and Worker names) and was built during the hackathon.
* **License:** [MIT](LICENSE), © 2026 Sushmit Sarmah / MonolithLabs.

---

# Reference

## Architecture details

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
  orchestrator-api/    Bun + Hono API (also a Cloudflare Worker): /api/auth/session, /api/whitelist, /api/admin/*, /api/generate,
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
| `KEY_ENCRYPTION_KEY` | – | base64 32-byte AES-256-GCM master key for stored AI keys (`openssl rand -base64 32`); unset = "bring your own key" disabled |
| `KEY_ENCRYPTION_KEY_VERSION` | `1` | version stamped on new records; `KEY_ENCRYPTION_KEY_PREV` + `_PREV_VERSION` still decrypt older ones during a rotation |
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
| `LOCKED` | **on** | access gate; `0`/`false` opens the app to every account (see [Access gate](#access-gate-whitelist)) |
| `ALLOWED_ACCOUNTS` | empty | comma-separated NEAR account ids allowed in while `LOCKED` |
| `PLATFORM_IDEAS_PER_ACCOUNT_DAY` / `PLATFORM_IDEAS_PER_IP_DAY` | `150` / `400` | daily caps on ideas generated with the shared platform key ([Limits on the shared AI key](#limits-on-the-shared-ai-key)); `0` = no cap |
| `AGENT_ACCOUNTS` / `AGENT_MAX_DAILY_NEAR` | empty / `2` (testnet: `3`) | Autopilot agents and the server ceiling on their daily spend |
| `ONECLICK_BASE_URL` / `ONECLICK_JWT` | `https://1click.chaindefuser.com` / – | NEAR Intents widget; the JWT (secret) is optional and only removes 1Click's unauthenticated fee |
| `LOOFTA_API_BASE` / `LOOFTA_PAY_BASE` | `https://api.loofta.com` / `https://pay.loofta.com` | Loofta widget. No platform key: creators bring their own (see [Token page payments](#token-page-payments-near-intents--loofta)) |

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

## Access gate (whitelist)

**Testnet is currently open (`LOCKED=0`) for hackathon judging**; mainnet stays locked. When locked (`LOCKED=1`, the code default), the allowlist is the union of
**KV `allow:<account>`** (`{approvedAt, approvedBy}`, written when an admin approves; no redeploy),
**`ALLOWED_ACCOUNTS`** (env var, bootstrap/fallback, currently empty) and **`ADMIN_ACCOUNTS`** (env var; admins are implicitly allowed).

* `POST /api/auth/session` verifies the signature as usual, then answers **403** `{ "error": "...", "code": "not_whitelisted" }` for any account not on the allowlist (checked after the signature, so the list can't be probed).
* `POST /api/generate`, `/api/launch`, `/api/launch/batch` and `PUT /api/site/:id/settings` re-check the allowlist on every call, so sessions issued before the lock or before a revoke get the same 403.
* KV `allow:` reads use `cacheTtl: 30` (the Workers KV minimum), so an approval or revoke takes effect within ~30 s (KV is eventually consistent; across distant regions it can take up to ~60 s).
* Public reads keep working: `/api/health` (reports `locked`, never the list), `/api/site/:id`, `/api/launches/:account`, `/api/balance/:account`, and the token pages `/t/*`.
* `GET /api/auth/me` returns `{ accountId, isAdmin, whitelisted, locked }`.
* Web: the landing CTA is "Join the whitelist"; `/app/` shows the whitelist form (with "Already whitelisted? Connect your wallet"); a 403 `not_whitelisted` shows "You're not on the whitelist yet" plus the form. To open the app to everyone, set `"LOCKED": "0"` in `apps/orchestrator-api/wrangler.jsonc` and `bun run deploy:api`.

### Admins

**Make an account an admin** (from the repo root; then commit the `wrangler.jsonc` change):

```bash
bun run admin your-wallet.testnet && bun run deploy:api
```

`bun run admin --list` shows admins, `bun run admin --remove x.testnet && bun run deploy:api` removes one. Admins are set by the `ADMIN_ACCOUNTS` var (testnet: `osl-e2e-mvhxupmb.testnet`, `sillypuma1184.testnet`; mainnet: `sillypuma1184.near`), not KV, so a leaked admin session can't create more admins.

**Day to day:** sign in at `/app/` with an admin wallet → an **🛡️ Admin** tab appears (hidden for everyone else; direct link `/app/#admin`). It lists waitlist requests with counts and Pending / Approved / Revoked / All filters, search, per-row **Approve** / **Revoke** / **Remove**, checkboxes with select-all and bulk actions, plus "Who's allowed in" (KV approvals, env and admin accounts) with a box to approve any account directly.

* **Approve** writes `allow:<account>` and marks the request approved (works for accounts that never joined, too).
* **Revoke** deletes `allow:<account>`; the request stays, marked revoked.
* **Remove** revokes and deletes the request (`waitlist:<account>`).
* Accounts in `ADMIN_ACCOUNTS` / `ALLOWED_ACCOUNTS` can't be revoked from the UI (the API says so); edit the var and redeploy.

Admin API (session bearer token + admin, otherwise 401 / 403 `{ "code": "not_admin" }`):

| endpoint | |
|---|---|
| `GET /api/admin/waitlist` | `{ entries: [{account, contact, joinedAt, status: pending\|approved\|revoked, approvedAt, approvedBy}], counts, allowed, truncated }`; follows KV list cursors (up to 20k). KV `list()` can lag writes by ~60 s, so it is only used to find keys; values and `allow:` state are re-read with bulk `get` (fresh): approvals/removals show immediately, brand-new signups within about a minute |
| `GET /api/admin/allowed` | `{ allowed: [{account, source: admin\|env\|kv, approvedAt, approvedBy}], truncated }` |
| `POST /api/admin/approve` | `{ accounts: [...] }` (1–100) → `{ results: [{account, ok, note?}] }` |
| `POST /api/admin/revoke` | same body; deletes `allow:` keys, keeps the requests |
| `POST /api/admin/remove` | same body; deletes `allow:` and `waitlist:` keys |

CLI alternative (writes KV directly, no redeploy): `bun run allow you.testnet`, `bun run allow --remove you.testnet`, `bun run allow --list`.

### Waitlist signups

`POST /api/whitelist` `{ "account": "<near id>", "contact"?: "<email or @handle, ≤100 chars>" }` (body ≤ 1 KiB) stores `waitlist:<account>` → `{account, contact, createdAt, updatedAt, status}` in the `SITES` KV namespace (`yeetpad-sites`), also as KV metadata. It is idempotent (`already: true` on repeats; the first `createdAt` is kept, a new contact updates the entry) and soft rate-limited to 10 signups per IP per hour (IPv6 counted per /64; `wlrl:<ip>:<window>` keys with a TTL). There is no public listing; admins use the Admin tab, or wrangler (from `apps/orchestrator-api`):

```bash
npx wrangler kv key list --binding SITES --remote --prefix waitlist:
```

Tests: `src/gate.test.ts` (lock/allowlist/admin parsing, KV approvals, 403 on session and on every spend/launch/settings endpoint for old or revoked sessions, admin-only endpoints, approve → 200 → revoke → 403, remove, KV list pagination, waitlist validation, idempotency, size and rate limits).

## NEAR AI

Uses the NEAR AI Cloud gateway, OpenAI-compatible: `POST https://cloud-api.near.ai/v1/chat/completions` with `Authorization: Bearer $NEARAI_API_KEY` ([quickstart](https://docs.near.ai/cloud/quickstart), [OpenAI compatibility](https://github.com/nearai/docs/blob/main/docs/cloud/guides/openai-compatibility.mdx), [API reference](https://docs.near.ai/api-reference/chat/create-chat-completion)). The client asks for `response_format: json_schema` (generated from the zod schema); if a model rejects that, it retries with `json_object`. The output is always validated with zod.

The format fallback is json_schema → json_object → no `response_format` (only a 400/422 moves on; auth/quota errors stop at once), so it works for every model on both allowed providers.

### AI keys: bring your own key + platform key

* **Providers** are a fixed allowlist in `apps/orchestrator-api/src/llmkeys.ts`: **NEAR AI** (`https://cloud-api.near.ai/v1`) and **Ollama** (`https://ollama.com/v1`). No custom base URLs (SSRF / key exfiltration). Every request that carries a stored key goes through `guardedFetch`: https, allowlisted URL only, redirects not followed.
* **Studio → AI key** (signed-in users): pick a provider, paste a key, pick a model (the API fetches `GET /models` with that key; cheap models first), Save. The API validates the key with a cheap authenticated call (Ollama `POST /api/me`; NEAR AI a 1-token chat completion, since `/models` is public on both) and stores it only if it works. Test / Change model / Replace / Delete.
* **Generation with your own key** calls your provider and **skips the 0.01 NEAR AI fee** (`charged: "0"`, `keySource: "user"`). Credits are still needed for launches. If your key fails (401/403/402/429) the API answers `424` (`user_key_failed` / `user_key_invalid`), charges nothing, and the Studio offers "Use the platform key instead" (normal fee); it never falls back on its own.
* **Admin → Platform AI key** (ADMIN_ACCOUNTS only, checked server-side): same form; stored as `llmkey:__platform__`, takes precedence over the `NEARAI_API_KEY` secret (the fallback, also used if the stored key stops validating).
* **Storage**: KV `llmkey:<account>` = `{v, kv (master key version), provider, model, iv, ct, createdAt, updatedAt, valid, validatedAt, lastError}`. `ct` is AES-256-GCM (WebCrypto) under `KEY_ENCRYPTION_KEY`, random 12-byte IV per record, AAD `yeetpad-llmkey|v1|<account>|<provider>`. Only ciphertext touches storage; even the last 4 characters are derived by decrypting.
* **Write-only**: no endpoint returns a key (only provider, model, last 4, dates, validity). Provider error text is dropped (it can echo the key); `llm_usage` logs carry source/provider/model/token counts only.
* **Limits**: idea caps on the shared key are described in [Limits on the shared AI key](#limits-on-the-shared-ai-key); 10 key saves/tests and 30 model lists per account per hour; keys are whitespace-stripped, 8-512 printable ASCII characters.
* Endpoints: `GET /api/llm/providers`; session: `GET|PUT|DELETE /api/llm/key`, `POST /api/llm/key/test`, `POST /api/llm/models`; admin: `GET|PUT|DELETE /api/admin/llm-key`, `POST /api/admin/llm-key/test`, `POST /api/admin/llm-models`. Tests: `src/llmkeys.test.ts`.

## Limits on the shared AI key

With `LOCKED=0` anyone can sign in, and test NEAR is free, so idea generation with the **platform** key (the admin-set key, or the `NEARAI_API_KEY` secret) has daily caps, in `apps/orchestrator-api/src/quota.ts`:

| var | testnet value | |
|---|---|---|
| `PLATFORM_IDEAS_PER_ACCOUNT_DAY` | `150` | ideas per account per UTC day (one 100-token run plus regenerations) |
| `PLATFORM_IDEAS_PER_IP_DAY` | `400` | ideas per client IP per UTC day (IPv6 per /64), so fresh wallets from one machine don't multiply the account cap |

* Counted in ideas (`count`), before the LLM call; a refused request counts nothing and charges nothing. Over the cap the API answers **429** `{code: "platform_quota", scope: "account" | "ip", limit, used}` and the Studio stops the run without retrying.
* **Exempt:** admins (`ADMIN_ACCOUNTS`) and Autopilot agents (they have their own server-enforced daily spend cap). Requests that use the caller's **own** AI key never touch these counters. The 0.01 NEAR credit charge per idea is unchanged.
* `0` disables a cap. KV counters (`aiq:a:<account>:<day>`, `aiq:i:<ip>:<day>`) are soft: not atomic, so a burst of parallel requests can overshoot slightly.
* Tests: `src/quota.test.ts`.

## Token page payments: NEAR Intents + Loofta

Two optional, independent widgets on `/t/<slug>` (a page can have either, both or neither). Both are **off by default**, switched per page in **My tokens** (bulk bar + per-row column) or before launch in the Studio (per idea, or "Enable … for all"; applied once the token shows up in My tokens). Both carry no Yeetpad branding and add no fee.

### NEAR Intents widget

* **Always NEAR mainnet, on every Yeetpad deployment** (1Click has no testnet): quotes, deposit addresses and swaps are real. The only network-dependent rule is the tip recipient:
  * **Tip** the creator in USDC/wNEAR, delivered to a **mainnet** account: the page's own recipient (My tokens → "set tip account") > the creator's payout account (Studio → **NEAR Intents tips**, KV `intentspay:<account>`, `GET /api/intents/settings`, `PUT /api/intents/payout {account | null}`) > on mainnet deployments the creator's own account. Every recipient is validated (`name.near` or another mainnet top-level, 64-hex or `0x` implicit; never `.testnet`, which doesn't exist on mainnet). With no mainnet recipient, tips are hidden and Studio / My tokens say why.
  * **Buy** (any asset → mainnet wNEAR via 1Click → swap to the token on Rhea with the visitor's wallet) is offered as configured on every deployment, with no special gating: if the token or its pool doesn't exist where the swap runs (a testnet token on mainnet), that step simply fails with the normal error.
* KV `intents:<ticker>`; `POST /api/tokens/intents` (creator or admin, ≤50 tickers); `GET /api/site/:id` → `intents` (the effective settings: mode reduced to what can be offered, plus the tip `recipient`; `null` if nothing can be); launches carry `intentsState {tip, buy, recipient, notes}`.
* Quotes go through `POST /api/intents/quote` (the server picks the destination, never adds app fees): `dry: true` gives a price-only quote, otherwise a binding quote with a deposit address. Status: `GET /api/intents/status`.
* Checks: `src/intents.test.ts`, `TICKERS=… [PAYOUT=x.near] bun scripts/e2e-intents.ts`, `SLUG=… bun scripts/headless-token.ts`.

### Loofta widget ("Tip the creator")

[Loofta](https://loofta.com) takes payments in any token on any chain and settles USDC on Solana for the recipient (cash-out to Venmo/Cash App/Revolut/Zelle). Payers pay Loofta's fees; the recipient gets the amount. Loofta's pages send `frame-ancestors 'none'`, so the widget opens Loofta in a new tab. **Loofta has no sandbox and no testnet** (API keys are live) and doesn't depend on NEAR, so the widget is **live on every Yeetpad deployment, testnet included**: each click makes a real payment link (or a real Send link).

Two routes; the server picks one per page: page payout target > creator's key > creator's payout target. The toggle is refused (`409`, "set up Loofta first") until the creator has a key or a payout target.

* **checkout (creator's own Loofta key, optional)**: Studio → **Loofta payments**, next to the AI key. The key (`lft_…`, created in Loofta → API key & branding, scope `payment_links:create`) is checked with a harmless `GET /payment-links/<random id>` (checked live: a valid key gets 404 `Payment link not found`, a bad one 401 = rejected, not stored; a route-level 404 `Cannot GET …` is not accepted) and stored exactly like AI keys: AES-256-GCM under `KEY_ENCRYPTION_KEY`, AAD `yeetpad-llmkey|v1|<account>|loofta`, KV `looftakey:<account>`, write-only (only the last 4 characters are ever returned). Each click makes the API call `POST https://api.loofta.com/payment-links` with the page owner's key (`{amount, message, is_private: false, return_url: <token page>}`) and returns only the `https://pay.loofta.com/checkout/<id>` URL (`url` in Loofta's response; `return_url` comes back baked in as `?callback=`; live the API answers with the `https://pay.loofta.xyz/checkout/<id>` host, which redirects to pay.loofta.com, so both hosts are accepted). The key check can't tell whether the key's Loofta account can receive payments: Loofta only says so when a link is created (400 `This API key has no owner to receive payments on behalf of.`). That click returns `409 provider_no_owner`, the key is marked invalid with a message for the creator, and the page falls back to the payout target (or hides). What the key adds: nothing about the creator is revealed, a fresh one-off guest checkout per payment (any token/chain, no Loofta sign-in), and the exact amount on the creator's Loofta account.
* **send (no key)**: the creator saves a payout target: email, X/Discord/GitHub/Telegram handle, or Loofta username (validated; Solana addresses aren't supported because Loofta's links can't prefill them). It's encrypted too (KV `looftapay:<account>`, per-page overrides inside `loofta:<ticker>`, AAD `…|<account or ticker:x>|loofta-payto`) and never in page config, HTML or `GET /api/launches`; visitors see a label only ("@name on X", "the creator (by email)"). A click returns Loofta's Send link (`/app?tab=send&to=…&method=email|social&platform=…&amount=…`, or `payto=<username>`). Caveat: after clicking, the payer's browser sees the target in that Loofta URL. Guests pay from a Solana wallet for email/social; username links need a Loofta sign-in.
* Endpoints: session `GET /api/loofta/settings`, `PUT|DELETE /api/loofta/key`, `POST /api/loofta/key/test`, `PUT /api/loofta/payto` (`{payTo: null}` clears); `POST /api/tokens/loofta` `{tokens, loofta: {enabled, payTo?}}` (creator or admin, ≤50; `payTo: null` clears a page override); public `POST /api/loofta/checkout` `{site, amount (USD 1–10000), message?}` (20 per IP per 10 min). `GET /api/site/:id` → `loofta: {enabled, route, label, preview: false} | null`; launches carry `loofta: {enabled, ready, custom}`.
* Checks: `src/loofta.test.ts`, `TICKERS=… bun scripts/e2e-loofta.ts` (bogus key rejected by Loofta, optional `PAYTO_EMAIL` target kept out of public responses, `CHECKOUT=1` creates one real unpaid link and checks it opens), `LOOFTA_KEY_FILE=… bun scripts/e2e-loofta-key.ts` (stores the e2e creator's key), `SLUG=… bun scripts/headless-loofta.ts`.
* Not used: Loofta's npm `@loofta/pay-sdk` (a React button that needs a Loofta-issued `organizationId`) and the payouts API (it sends from the integrator's own balance).

## Autopilot agent

An AI agent with its own NEAR account that runs a tiny token business on rules a human sets: it generates ideas,
drops duplicate / invalid / taken tickers, launches the tokens from its own prepaid vault credits, lists them on
Rhea, and writes every run to a public ledger. Live agent: `yeetpad-autopilot.testnet`, ledger at
[yeetpad.fun/agent/yeetpad-autopilot.testnet](https://yeetpad.fun/agent/yeetpad-autopilot.testnet).

**Its wallet.** The account has **no full-access key**. `scripts/setup-agent.ts` created it with a temporary
full-access key held only in memory, deposited its NEAR as Yeetpad credits, added a function-call key limited to
the vault (`launch-vault.osl-launchpad-5786.testnet`, method `get_balance`, 0.01 NEAR allowance), then deleted the
full-access key on-chain. The limited key can't move NEAR or call any other contract; it's only used to sign the
NEP-413 sign-in. Sign-in accepts such a key only for accounts admins listed as agents (`AGENT_ACCOUNTS` in
`wrangler.jsonc`, or `POST /api/admin/agents`); every other account still needs a full-access key.

**Human rules** live in [`agent.config.json`](agent.config.json): launches per run, max credits per day, theme,
venue (`none` / `rhea`). The agent publishes them each run, and the API enforces, server-side:
- the **kill switch** (KV, admins only: `bun run agent:kill on|off` or `POST /api/admin/agent/kill`). While on,
  every gated call by the agent fails with 423;
- the **daily cap**: min(its rules, `AGENT_MAX_DAILY_NEAR`), against a server-side spend counter (429 when over).

Try it:
1. `bun run autopilot`: see it sign in with the limited key, generate 3 ideas, launch them and list on Rhea in
   about 40 s, then print the ledger URL.
2. Open the ledger: see the key badge ("function-call key only, vault only"), credits, rules, kill switch, cap
   used today, and each run with token pages (`/t/<slug>`), NearBlocks and Rhea pool links and tx hashes.
3. `bun run agent:kill on yeetpad-autopilot.testnet demo`, then `bun run autopilot`: see the run stop, recorded
   as `stopped` in the ledger (`SKIP_PRECHECK=1` shows the API refusing it too). `bun run agent:kill off` resumes.
4. Lower `maxCreditsPerDayNear` below today's spend and run again: see it stop on the daily cap.

Honest limits: **testnet only**. It **spends but doesn't earn** on testnet (there are no real trading fees to
collect), so it runs until its credits or daily cap run out. Credits can't be withdrawn back, since nobody holds a
full-access key. It runs on demand (`bun run autopilot`, or any cron); there's no Worker cron trigger yet. The
ledger is written by the agent's own session, so it's the agent's account of its runs; every entry links the
on-chain transactions to check it.

## Swarm Market (AI Swarms: many agents, one economy)

25 agents trade Yeetpad tokens in sealed-bid rounds on testnet. Five **seller agents** each launched their own
Yeetpad token through the Yeetpad factory and auction lots of it every round. Twenty **buyer agents** with scripted
strategies pool their demand into those lots: they commit a hash of their bid with a NEAR deposit, reveal it,
and each lot clears at one uniform price, so every winner pays only for its own share. The coordinator is the
`contracts/swarm-market` contract, and the rules are in [`RULES.md`](RULES.md) (written before the contract,
with a sequence diagram of one round). No LLM calls; no fees.

| | Testnet account |
| --- | --- |
| Parent (owns every agent, opens rounds) | `yeetpad-swarm.testnet` |
| Coordinator contract | [`market.yeetpad-swarm.testnet`](https://testnet.nearblocks.io/address/market.yeetpad-swarm.testnet) |
| Sellers | `seller-1` … `seller-5` `.yeetpad-swarm.testnet` |
| Buyers | `buyer-1` … `buyer-20` `.yeetpad-swarm.testnet` |
| Tokens | `swarmpaw`, `swarmzap`, `swarmmoon`, `swarmfrog`, `swarmbyte` `.ft-factory.osl-launchpad-5786.testnet` |

Live page: [yeetpad.fun/swarm](https://yeetpad.fun/swarm/). It reads the contract straight from testnet RPC and
shows the current phase, every round's lots, commit hashes, reveals, clearing prices, winners, refunds,
deliveries and transaction links, a clearing-price chart, and each agent's balance and net NEAR.

Try it:
1. `bun run swarm -- --offline --rounds 5`: see the same market run in memory (no chain, no keys, no LLM), with
   lots, clearing prices, winners, no-reveal penalties and each agent's net NEAR and tokens.
2. `bun run swarm -- --rounds 3`: see three full rounds on testnet, about 2 minutes each: sellers list, 20 buyers
   commit, then reveal, then `clear` and `deliver` settle, with a NearBlocks link for each step. (Needs the parent
   key in `~/.secrets/near_yeetpad-swarm.testnet.json`; agent keys go in `~/.secrets/swarm-agents.json`.)
3. Open [yeetpad.fun/swarm](https://yeetpad.fun/swarm/) during a run: see the phase move through Listing → Commit
   → Reveal → Clear → Settled, then the new round's bids, prices and deliveries appear.
4. `bun run swarm -- status`: see the latest rounds from chain. `bun run test:swarm` and
   `cargo test -p swarm-market` run the engine and contract tests (contract tests are named after the RULES.md rule).

How it fits the track:
- **Sub-accounts:** every agent is its own sub-account of one parent, with its own key, so each listing, commit and
  reveal on chain traces back to one agent.
- **Sealed bids:** `sha256("round:lot:buyer:qty:price:salt")` commits, then reveals checked on-chain. Phase deadlines
  come from block time, so nobody can end a phase early. Not revealing costs 10% of the deposit (paid to the seller).
- **Clearing:** uniform-price, multi-unit per lot (highest bids first, last winner partly filled, everyone pays the
  lowest winning price).
- **Settlement:** the contract holds the tokens and the NEAR, and in `clear` it sends NEAR refunds and seller
  proceeds; `deliver` then registers each winner on the token and sends its tokens.
- **Strategies** (`scripts/swarm/engine.ts`): sellers are anchor, adaptive, premium, dumper and scarcity. Buyers are
  truthful, shader, bargain, momentum, whale, flake (sometimes doesn't reveal) and splitter (bids on two lots).
  Values are private and seeded, and every buyer deposits its whole budget so the deposit doesn't give away its bid.

Honest limits:
- **Testnet, and no NEAR Intents.** The Intents verifier only runs on mainnet, so settlement uses direct NEAR and
  NEP-141 transfers from the contract's escrow (RULES.md explains where Intents would slot in on mainnet).
- **Scripted agents.** The strategies are simple rules, not learning agents, and all 25 agents are run by one script
  (`scripts/swarm-sim.ts`). The keys are separate, but it's one operator.
- **No discovery layer.** Buyers "find each other" by bidding into the same lot; there's no off-chain matchmaking or
  messaging between agents.
- **Deposits leak an upper bound.** A commit's deposit is public, so it caps what that buyer can pay. Agents deposit a
  fixed budget to hide their real bid.
- **The coordinator triggers settlement.** `clear` and `deliver` can be called by anyone, but in the sim the parent
  calls them and pays the gas, because 300 Tgas needs about 0.3 NEAR of headroom, more than an agent keeps.
  Transaction hashes are attached to each round by the owner (`annotate`) for the page; they can't change any
  amount or outcome.
- **Small amounts.** Prices are around 0.00001 NEAR per token, so a round moves about 0.03–0.05 NEAR. Test tokens have
  no value.

## Deploy contracts (testnet)

```bash
bun run contracts:build
cp scripts/.env.example scripts/.env   # fill NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY
bun run deploy:factory                 # creates/deploys/inits ft-factory.<you>.testnet
bun run deploy:vault                   # creates/deploys/inits launch-vault.<you>.testnet with relayer + factory
```

Upgrade in place (keeps state and addresses; runs `migrate`): `bun run contracts:upgrade`.

Sub-accounts are created with the parent's public key. Re-running redeploys code (state kept) and, for the vault, ensures the relayer is registered. The token code is a global contract, so each launch needs about 0.076 NEAR (factory `get_required_deposit`).

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
# AI key master key (testnet copy kept in ~/.secrets/yeetpad_key_encryption_key_testnet, chmod 600; losing it = stored keys unreadable)
npx -y wrangler@4.86.0 secret put KEY_ENCRYPTION_KEY < ~/.secrets/yeetpad_key_encryption_key_testnet
```

Wrangler is pinned to 4.86.0 because newer 4.x releases need Node 22 (the box has Node 20); with Node 22+ any 4.x works. `bun run deploy:api` needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.

Token sites need the KV namespace (`wrangler kv namespace create yeetpad-sites`; its id is in `kv_namespaces` in `apps/orchestrator-api/wrangler.jsonc`). The API token needs **Workers KV Storage: Edit** for that one-time create; `SITE_BASE` sets the public site URL (`https://yeetpad.fun`). Outside Workers (Bun dev, tests) an in-memory store is used.

A token with **Account > Workers Scripts: Edit** is enough (set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). The API is not deployed by Workers Builds; redeploy it with the command above after API changes. Keep `CORS_ORIGINS` in `vars` in sync with the frontend origins (currently `https://yeetpad.fun`, `https://www.yeetpad.fun`, the workers.dev URL and `http://localhost:4321`). The NEP-413 recipient is the vault id, not the origin, so adding a domain needs no auth change.

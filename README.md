# one_shot_launchpad (NEAR testnet)

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
* **Launch**: API checks the ticker is free and the balance covers the factory's `get_required_deposit`, then the relayer calls `execute_sponsored_launch`. The vault debits the user, calls `create_token` on the factory with the deposit, and its callback **refunds the user** if anything fails (factory panic or sub-account creation failure).

```
apps/
  studio-web/          Astro (static) + React island: wallet connect, top-up, generate, launch
  orchestrator-api/    Bun + Hono API: /api/generate, /api/launch, /api/balance/:account
packages/
  schema/              zod: LaunchIdea, SiteConfig, API request/response types, NEAR helpers
contracts/
  near-ft-token/       NEP-141 (+NEP-145/148) via near-contract-standards; full supply → owner
  near-ft-factory/     create_token(ticker, metadata, total_supply, owner_id); embeds token wasm
  near-launch-vault/   credits vault: deposit / deduct / sponsored launch / withdraw / relayers
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
| `add_relayer` / `remove_relayer` / `set_platform_fee_bps` / `set_ft_factory` / `withdraw_treasury` | owner | |
| `get_balance(account_id)`, `get_relayers()`, `get_config()` | view | |

`token` = `{ ticker, name, symbol?, icon?, decimals?, total_supply }`. Tickers: 2–16 chars, `a-z0-9`, starting with a letter (validated in the factory and in `packages/schema`). All balance math uses checked add/sub/mul.

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

Smoke test the API:

```bash
curl -s -XPOST localhost:8787/api/generate -H 'content-type: application/json' \
  -d '{"prompt":"a meme coin about sleepy penguins","ownerWallet":"alice.testnet"}'
curl -s localhost:8787/api/balance/alice.testnet
```

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

### `apps/studio-web/.env` (build-time, `PUBLIC_*`)

| var | |
|---|---|
| `PUBLIC_API_URL` | orchestrator base URL, e.g. `https://api.example.com` |
| `PUBLIC_VAULT_CONTRACT` | vault account id |
| `PUBLIC_NEAR_RPC_URL` | optional, default `https://test.rpc.fastnear.com` |

### `scripts/.env`

`NEAR_ACCOUNT_ID` (parent `*.testnet`), `NEAR_PRIVATE_KEY`, optional `FT_FACTORY_ACCOUNT_ID`, `VAULT_ACCOUNT_ID`, `RELAYER_ACCOUNT_ID`, `PLATFORM_FEE_BPS`, `FACTORY_INITIAL_BALANCE` (5), `VAULT_INITIAL_BALANCE` (3).

Never commit real `.env` files; only `.env.example` is tracked.

## NEAR AI

Uses the NEAR AI Cloud gateway, OpenAI-compatible: `POST https://cloud-api.near.ai/v1/chat/completions` with `Authorization: Bearer $NEARAI_API_KEY` ([quickstart](https://docs.near.ai/cloud/quickstart), [OpenAI compatibility](https://github.com/nearai/docs/blob/main/docs/cloud/guides/openai-compatibility.mdx), [API reference](https://docs.near.ai/api-reference/chat/create-chat-completion)). The client asks for `response_format: json_schema` (generated from the zod schema); if a model rejects that, it retries with `json_object`. The output is always validated with zod.

## Deploy contracts (testnet)

```bash
bun run contracts:build
cp scripts/.env.example scripts/.env   # fill NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY
bun run deploy:factory                 # creates/deploys/inits ft-factory.<you>.testnet
bun run deploy:vault                   # creates/deploys/inits launch-vault.<you>.testnet with relayer + factory
```

Sub-accounts are created with the parent's public key. Re-running redeploys code (state kept) and, for the vault, ensures the relayer is registered. Each token launch needs roughly 1.8 NEAR of storage (see factory `get_required_deposit`), so users should top up ~2+ NEAR.

## Cloudflare Pages (studio-web)

| setting | value |
|---|---|
| Root directory | `apps/studio-web` |
| Build command | `bun install && bun run build` |
| Output directory | `dist` |
| Env vars | `PUBLIC_API_URL`, `PUBLIC_VAULT_CONTRACT`, (`PUBLIC_NEAR_RPC_URL`), `BUN_VERSION=1.4.2` |

The build runs Astro under the Bun runtime (`bun --bun astro build`), so the Node version on the build image doesn't matter. The output is fully static (React island, `client:only`).

The orchestrator API is a plain Bun server (`bun run --cwd apps/orchestrator-api start`); host it anywhere that runs Bun (Fly, Railway, a VM). The Hono app is in `src/app.ts` if you later want to port it to Workers.

## Known limitations / later

* **API calls are not authenticated by the wallet**: anyone who knows an account id can spend that account's credits on generations or launches (the tokens still go to the owner, and the funds go to treasury or token storage, never to the caller). Next step: require a NEP-413 `signMessage` signature (or a short-lived session) on `/api/generate` and `/api/launch`.
* Cloudflare KV site storage, custom domains and the Solana path are out of scope here.
* `buyUrl` points at the token's nearblocks page until a DEX pool is set up.

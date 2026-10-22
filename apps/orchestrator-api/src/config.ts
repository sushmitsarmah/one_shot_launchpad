/**
 * Runtime config. Values come from an env-like record:
 *  - Bun server / tests: `process.env` at module load (see bottom of file).
 *  - Cloudflare Worker: the Worker `env` bindings, applied via `configureFromEnv(c.env)`
 *    on the first request (see src/worker.ts). Nothing here requires `process` to exist.
 */
export type EnvSource = Record<string, unknown>;

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function buildConfig(src: EnvSource = {}) {
  const env = (k: string, d?: string): string | undefined => {
    const v = src[k];
    return typeof v !== "string" || v === "" ? d : v;
  };
  const flag = (k: string) => ["1", "true", "yes"].includes((env(k) ?? "").toLowerCase());

  return {
    port: Number(env("PORT", "8787")),
    corsOrigins: (env("CORS_ORIGINS", "*") as string).split(",").map((s) => s.trim()).filter(Boolean),

    // NEAR AI Cloud (OpenAI-compatible). Docs: https://docs.near.ai/cloud/quickstart
    llmMock: flag("LLM_MOCK"),
    nearAiBaseUrl: env("NEARAI_BASE_URL", "https://cloud-api.near.ai/v1") as string,
    nearAiModel: env("NEARAI_MODEL", "z-ai/glm-5.3-flash") as string,
    llmMaxTokens: Number(env("LLM_MAX_TOKENS", "500")),
    nearAiApiKey: env("NEARAI_API_KEY"),

    // NEAR testnet
    nearMock: flag("NEAR_MOCK"),
    networkId: "testnet" as const,
    rpcUrl: env("NEAR_RPC_URL", "https://test.rpc.fastnear.com") as string,
    vaultContract: env("VAULT_CONTRACT", "launch-vault.testnet") as string,
    factoryContract: env("FT_FACTORY_CONTRACT", "ft-factory.testnet") as string,
    relayerAccountId: env("RELAYER_ACCOUNT_ID"),
    relayerPrivateKey: env("RELAYER_PRIVATE_KEY"),

    // Pricing (yoctoNEAR). Default 0.01 NEAR per generation.
    aiComputeCostYocto: env("AI_COMPUTE_COST_YOCTO", (10n ** 22n).toString()) as string,
    // Default supply 1,000,000,000 tokens with 18 decimals.
    tokenTotalSupply: env("TOKEN_TOTAL_SUPPLY", (10n ** 27n).toString()) as string,
    tokenDecimals: Number(env("TOKEN_DECIMALS", "18")),
    explorerBase: env("EXPLORER_BASE", "https://testnet.nearblocks.io") as string,
    /** Public base URL of the web app; token pages live at <siteBase>/t/<ticker>. */
    siteBase: env("SITE_BASE", "https://yeetpad.fun") as string,

    // Launch venues. Rhea direct: the vault lists on Rhea DCL. Nearly: the creator's wallet calls `launch`.
    dclContract: env("DCL_CONTRACT", "dclv2.ref-dev.testnet") as string,
    wnearContract: env("WNEAR_CONTRACT", "wrap.testnet") as string,
    /** Default opening FDV in NEAR for Rhea listings (sets the pool's init_point). */
    rheaDefaultFdvNear: Number(env("RHEA_DEFAULT_FDV_NEAR", "1000")),
    /** NEAR attached to create_pool (Rhea refunds what it doesn't use; ~0.0101 observed on testnet). */
    rheaPoolDepositYocto: env("RHEA_POOL_DEPOSIT_YOCTO", (2n * 10n ** 22n).toString()) as string,
    rheaPoolUrlBase: env("RHEA_POOL_URL_BASE", "https://testnet.rhea.finance/poolV2/") as string,
    nearlyFactory: env("NEARLY_FACTORY", "dcl.nearpad-dev-4804.testnet") as string,
    /** Nearly token page; empty = use the explorer. Mainnet: https://nearly.trade/token/ (unverified path). */
    nearlyTokenUrlBase: env("NEARLY_TOKEN_URL_BASE", "") as string,
    nearlyBatchChunk: Number(env("NEARLY_BATCH_CHUNK", "10")),
    /** Off by default: Nearly's testnet factory currently fails at add_liquidity (see docs/launch-venues.md). */
    nearlyEnabled: flag("NEARLY_ENABLED"),
    nearlyDisabledReason: env(
      "NEARLY_DISABLED_REASON",
      "Nearly's testnet factory fails at add_liquidity right now (Rhea testnet DCL rejects its Deposit); enabled on mainnet.",
    ) as string,
    // JustHoot (mainnet only): the creator's wallet calls `launch_meme`. Off until mainnet launch.
    justhootEnabled: flag("JUSTHOOT_ENABLED"),
    justhootFactory: env("JUSTHOOT_FACTORY", "v2-launchpad.justhoot.near") as string,
    /** JustHoot views/tx lookups go here (mainnet), independent of NEAR_RPC_URL. */
    justhootRpcUrl: env("JUSTHOOT_RPC_URL", "https://rpc.mainnet.fastnear.com") as string,
    justhootUrlBase: env("JUSTHOOT_URL_BASE", "https://justhoot.fun/p/") as string,
    justhootBatchChunk: Number(env("JUSTHOOT_BATCH_CHUNK", "10")),
    /** Fill launch_meme's `reference` with our own metadata JSON (served by this API). JUSTHOOT_REFERENCE=0 sends null. */
    justhootReference: !["0", "false", "no", "off"].includes((env("JUSTHOOT_REFERENCE", "1") as string).toLowerCase()),
    justhootDisabledReason: env("JUSTHOOT_DISABLED_REASON", "mainnet only, enabled at mainnet launch") as string,
    /** Public base URL of this API (used for JustHoot's `reference` link). */
    publicApiBase: (env("PUBLIC_API_BASE", "https://one-shot-launchpad-api.sushmitsarmah.workers.dev") as string).replace(/\/$/, ""),

    // Auth: HMAC secret for session tokens (wrangler secret / .env). NEP-413 recipient defaults to the vault id.
    sessionSecret: env("SESSION_SECRET"),
    authRecipient: env("AUTH_RECIPIENT", env("VAULT_CONTRACT", "launch-vault.testnet")) as string,

    // Access gate. LOCKED defaults ON: only allowlisted accounts may sign in or spend/launch. The allowlist is
    // KV `allow:<account>` (approved by admins) ∪ ALLOWED_ACCOUNTS (bootstrap var) ∪ ADMIN_ACCOUNTS.
    // Set LOCKED=0 to open the app to everyone.
    locked: !["0", "false", "no", "off"].includes((env("LOCKED", "1") as string).toLowerCase()),
    allowedAccounts: list(env("ALLOWED_ACCOUNTS", "")),
    /** Can use /api/admin/* (approve/revoke/remove waitlist requests). Implicitly allowlisted. */
    adminAccounts: list(env("ADMIN_ACCOUNTS", "")),
  };
}

export type Config = ReturnType<typeof buildConfig>;

const processEnv = (): EnvSource =>
  ((globalThis as { process?: { env?: EnvSource } }).process?.env ?? {}) as EnvSource;

/** Live config object; mutated in place by `configureFromEnv` so importers always see current values. */
export const config: Config = buildConfig(processEnv());

let version = 0;
/** Bumped on every reconfigure so lazily-built clients know to rebuild. */
export const configVersion = () => version;

/** Replace the config from an env record (e.g. Worker bindings). process.env, if any, is the fallback. */
export function configureFromEnv(src: EnvSource): Config {
  Object.assign(config, buildConfig({ ...processEnv(), ...src }));
  version++;
  return config;
}

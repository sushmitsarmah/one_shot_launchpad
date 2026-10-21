/**
 * Runtime config. Values come from an env-like record:
 *  - Bun server / tests: `process.env` at module load (see bottom of file).
 *  - Cloudflare Worker: the Worker `env` bindings, applied via `configureFromEnv(c.env)`
 *    on the first request (see src/worker.ts). Nothing here requires `process` to exist.
 */
export type EnvSource = Record<string, unknown>;

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

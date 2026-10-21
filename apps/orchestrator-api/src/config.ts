const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};
const flag = (k: string) => ["1", "true", "yes"].includes((process.env[k] ?? "").toLowerCase());

export const config = {
  port: Number(env("PORT", "8787")),
  corsOrigins: (env("CORS_ORIGINS", "*") as string).split(",").map((s) => s.trim()),

  // NEAR AI Cloud (OpenAI-compatible). Docs: https://docs.near.ai/cloud/quickstart
  llmMock: flag("LLM_MOCK"),
  nearAiBaseUrl: env("NEARAI_BASE_URL", "https://cloud-api.near.ai/v1") as string,
  nearAiModel: env("NEARAI_MODEL", "z-ai/glm-5.3-flash") as string,
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

export type Config = typeof config;

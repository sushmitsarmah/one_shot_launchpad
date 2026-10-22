interface ImportMetaEnv {
  readonly PUBLIC_API_URL?: string;
  readonly PUBLIC_VAULT_CONTRACT?: string;
  readonly PUBLIC_NEAR_RPC_URL?: string;
  readonly PUBLIC_EXPLORER_BASE?: string;
  readonly PUBLIC_NETWORK?: "testnet" | "mainnet";
  readonly PUBLIC_LAUNCH_COST?: string;
  readonly PUBLIC_SITE_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

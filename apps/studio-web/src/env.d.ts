interface ImportMetaEnv {
  readonly PUBLIC_API_URL?: string;
  readonly PUBLIC_VAULT_CONTRACT?: string;
  readonly PUBLIC_NEAR_RPC_URL?: string;
  readonly PUBLIC_EXPLORER_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

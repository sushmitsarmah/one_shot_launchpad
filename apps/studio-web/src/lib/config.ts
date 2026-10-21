export const API_URL = (import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const VAULT_CONTRACT = import.meta.env.PUBLIC_VAULT_CONTRACT ?? "launch-vault.testnet";
export const RPC_URL = import.meta.env.PUBLIC_NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
export const NETWORK = "testnet" as const;

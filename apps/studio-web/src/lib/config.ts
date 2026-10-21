// Build-time config. PUBLIC_* env vars override these defaults; the defaults point at the
// deployed testnet stack so the Cloudflare Workers Builds deploy needs no extra env vars.
export const API_URL = (import.meta.env.PUBLIC_API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev").replace(/\/$/, "");
export const VAULT_CONTRACT = import.meta.env.PUBLIC_VAULT_CONTRACT ?? "launch-vault.osl-launchpad-5786.testnet";
export const RPC_URL = import.meta.env.PUBLIC_NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
export const NETWORK = "testnet" as const;
export const EXPLORER_BASE = (import.meta.env.PUBLIC_EXPLORER_BASE ?? "https://testnet.nearblocks.io").replace(/\/$/, "");

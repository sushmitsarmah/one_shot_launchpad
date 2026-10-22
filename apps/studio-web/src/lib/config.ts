// Build-time config. PUBLIC_NETWORK=mainnet|testnet (default testnet) picks the defaults below; every
// value can still be overridden by its own PUBLIC_* var. Testnet defaults point at the deployed testnet
// stack, so the Cloudflare Workers Builds deploy of the testnet site needs no extra env vars.
export const NETWORK: "testnet" | "mainnet" = import.meta.env.PUBLIC_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const IS_MAINNET = NETWORK === "mainnet";
const net = <T,>(testnet: T, mainnet: T): T => (IS_MAINNET ? mainnet : testnet);
export const API_URL = (
  import.meta.env.PUBLIC_API_URL ?? net("https://one-shot-launchpad-api.sushmitsarmah.workers.dev", "https://one-shot-launchpad-api-mainnet.sushmitsarmah.workers.dev")
).replace(/\/$/, "");
export const VAULT_CONTRACT = import.meta.env.PUBLIC_VAULT_CONTRACT ?? net("launch-vault.osl-launchpad-5786.testnet", "vault.yeetpad.near");
export const RPC_URL = import.meta.env.PUBLIC_NEAR_RPC_URL ?? net("https://test.rpc.fastnear.com", "https://rpc.mainnet.fastnear.com");
export const EXPLORER_BASE = (import.meta.env.PUBLIC_EXPLORER_BASE ?? net("https://testnet.nearblocks.io", "https://nearblocks.io")).replace(/\/$/, "");
/** Short label used in copy: "testnet" / "mainnet". */
export const NET_LABEL = NETWORK;
/** Rhea DCL v2 (positions are withdrawn from here when a token is taken down). */
export const DCL_CONTRACT = import.meta.env.PUBLIC_DCL_CONTRACT ?? net("dclv2.ref-dev.testnet", "dclv2.ref-labs.near");

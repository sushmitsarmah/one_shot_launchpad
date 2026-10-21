// Shared helpers for testnet deploy scripts. Reads everything from env (Bun auto-loads ./.env).
import { Account, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from "near-api-js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (see scripts/.env.example)`);
  return v;
};
export const opt = (k: string, d: string) => process.env[k] || d;

export const RPC = opt("NEAR_RPC_URL", "https://test.rpc.fastnear.com");
export const MASTER_ID = need("NEAR_ACCOUNT_ID"); // e.g. yourname.testnet
export const MASTER_KEY = need("NEAR_PRIVATE_KEY") as KeyPairString; // ed25519:...
if (!MASTER_ID.endsWith(".testnet")) throw new Error("testnet only: NEAR_ACCOUNT_ID must end with .testnet");

export const provider = new JsonRpcProvider({ url: RPC });
export const master = new Account(MASTER_ID, provider, MASTER_KEY);
export const FACTORY_ID = opt("FT_FACTORY_ACCOUNT_ID", `ft-factory.${MASTER_ID}`);
export const VAULT_ID = opt("VAULT_ACCOUNT_ID", `launch-vault.${MASTER_ID}`);

export function wasm(name: string): Uint8Array {
  const p = resolve(import.meta.dir, "../contracts/res", `${name}.wasm`);
  if (!existsSync(p)) throw new Error(`${p} not found: run \`bun run contracts:build\` first`);
  return new Uint8Array(readFileSync(p));
}

export async function exists(accountId: string) {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates `<prefix>.<master>` (if missing) with the master's public key, deploys `code`
 * and returns an Account for it. Re-deploying an existing account keeps state.
 */
export async function ensureSubAccountWithCode(accountId: string, initialNear: string, code: Uint8Array) {
  if (!accountId.endsWith(`.${MASTER_ID}`)) throw new Error(`${accountId} must be a sub-account of ${MASTER_ID}`);
  if (!(await exists(accountId))) {
    console.log(`creating ${accountId} with ${initialNear} NEAR`);
    await master.createSubAccount({
      accountOrPrefix: accountId.slice(0, -(MASTER_ID.length + 1)),
      publicKey: KeyPair.fromString(MASTER_KEY).getPublicKey(),
      nearToTransfer: nearToYocto(initialNear as `${number}`),
    });
  }
  const acc = new Account(accountId, provider, MASTER_KEY);
  console.log(`deploying ${code.length} bytes to ${accountId}`);
  const r = await acc.deployContract(code);
  console.log(`  tx ${r.transaction.hash}`);
  return acc;
}

export async function isInitialized(contractId: string, viewMethod: string) {
  try {
    await provider.callFunction({ contractId, method: viewMethod, args: {} });
    return true;
  } catch {
    return false;
  }
}

// One-time setup of a Yeetpad Autopilot agent account on testnet (README "Autopilot agent").
//  1. creates AGENT (a top-level .testnet account via the `testnet` registrar) with a temporary full-access key,
//     funded by FUNDER;
//  2. deposits AGENT's NEAR as Yeetpad credits (deposit_credits, signed by AGENT itself so the credits are its own);
//  3. adds a FunctionCall key limited to the vault (method get_balance only, tiny allowance) and writes it to
//     ~/.secrets/near_<AGENT>.json (chmod 600);
//  4. deletes the temporary full-access key on-chain. The full-access key only ever lived in this process's memory.
// Usage: AGENT=yeetpad-autopilot.testnet FUND_NEAR=2.5 CREDITS_NEAR=2.35 bun setup-agent.ts
// Testnet only. Never prints key material.
import { Account, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from "near-api-js";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const AGENT = process.env.AGENT ?? "yeetpad-autopilot.testnet";
const VAULT = process.env.VAULT_CONTRACT ?? "launch-vault.osl-launchpad-5786.testnet";
const FUND = (process.env.FUND_NEAR ?? "2.5") as `${number}`;
const CREDITS = (process.env.CREDITS_NEAR ?? "2.35") as `${number}`;
const FUNDER_FILE = process.env.FUNDER_KEY_FILE ?? `${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`;
const OUT = `${process.env.HOME}/.secrets/near_${AGENT}.json`;
if (!AGENT.endsWith(".testnet") || !VAULT.endsWith(".testnet")) throw new Error("testnet only");
if (existsSync(OUT)) throw new Error(`${OUT} already exists; refusing to overwrite`);

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const f = JSON.parse(readFileSync(FUNDER_FILE, "utf8")) as { account_id: string; private_key: string };
const funder = new Account(f.account_id, provider, f.private_key as KeyPairString);

const temp = KeyPair.fromRandom("ed25519"); // full access, memory only
const limited = KeyPair.fromRandom("ed25519");
// Save the limited key before anything on-chain so it can't be lost.
writeFileSync(OUT, JSON.stringify({ account_id: AGENT, public_key: limited.getPublicKey().toString(), private_key: limited.toString(), permission: { receiver_id: VAULT, method_names: ["get_balance"] } }), { mode: 0o600 });
chmodSync(OUT, 0o600);
console.log(`limited key saved to ${OUT} (600)`);

let exists = true;
try {
  await provider.viewAccount({ accountId: AGENT });
} catch {
  exists = false;
}
if (exists) throw new Error(`${AGENT} already exists`);
console.log(`creating ${AGENT} with ${FUND} NEAR from ${f.account_id}`);
const c = await funder.callFunctionRaw({
  contractId: "testnet",
  methodName: "create_account",
  args: { new_account_id: AGENT, new_public_key: temp.getPublicKey().toString() },
  deposit: nearToYocto(FUND),
  gas: 100n * 10n ** 12n,
});
console.log(`  tx ${c.transaction.hash}`);

const agent = new Account(AGENT, provider, temp.toString() as KeyPairString);
const d = await agent.callFunctionRaw({ contractId: VAULT, methodName: "deposit_credits", args: {}, deposit: nearToYocto(CREDITS), gas: 30n * 10n ** 12n });
console.log(`deposit_credits ${CREDITS} NEAR: tx ${d.transaction.hash}`);
const a = await agent.addFunctionCallAccessKey({ publicKey: limited.getPublicKey(), contractId: VAULT, methodNames: ["get_balance"], allowance: nearToYocto("0.01") });
console.log(`added function-call key (vault only): tx ${a.transaction.hash}`);
const del = await agent.deleteKey(temp.getPublicKey());
console.log(`deleted temporary full-access key: tx ${del.transaction.hash}`);

const keys = await provider.viewAccessKeyList({ accountId: AGENT });
for (const k of keys.keys) {
  const p = k.access_key.permission;
  console.log(`  key ${k.public_key.slice(0, 16)}… ${p === "FullAccess" ? "FULL ACCESS" : `FunctionCall → ${p.FunctionCall.receiver_id} [${p.FunctionCall.method_names.join(",")}]`}`);
}
if (keys.keys.some((k) => k.access_key.permission === "FullAccess")) throw new Error("a full-access key is still on the account!");
const bal = await provider.callFunction({ contractId: VAULT, method: "get_balance", args: { account_id: AGENT } });
console.log(`credits: ${(Number(bal) / 1e24).toFixed(4)} NEAR`);

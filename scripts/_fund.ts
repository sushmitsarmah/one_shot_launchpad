// Create one helper-funded testnet account, save its key (600), print only id + status + balance.
import { KeyPair, JsonRpcProvider } from "near-api-js";
import { writeFileSync, chmodSync } from "node:fs";
const id = `osl-fund-${Date.now().toString(36)}.testnet`;
const kp = KeyPair.fromRandom("ed25519");
const file = `${process.env.HOME}/.secrets/near_${id}.json`;
writeFileSync(file, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }));
chmodSync(file, 0o600);
const url = process.argv[2] ?? "https://helper.testnet.near.org/account";
const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
const t = await r.text();
console.log(id, r.status, t.slice(0, 200).replace(/ed25519:[A-Za-z0-9]+/g, "<key>"));
await new Promise((s) => setTimeout(s, 3000));
try {
  const a = await new JsonRpcProvider({ url: "https://rpc.testnet.fastnear.com" }).viewAccount({ accountId: id });
  console.log("balance", Number(BigInt(a.amount)) / 1e24);
} catch (e) { console.log("no account:", String(e).slice(0, 120)); }

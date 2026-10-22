// Live testnet check of "bring your own AI key", signed with the e2e key (no browser wallet).
// Usage: BYOK_KEY_ENV=OLLAMA_API_KEY bun e2e-byok.ts   (reads the provider key from that env var; never prints it)
//   1. non-admin can't touch the platform key; custom base URL / unknown provider rejected; invalid key rejected, not stored
//   2. saves the key (provider BYOK_PROVIDER, default ollama), checks no response contains it
//   3. generates 1 idea with it: charged 0, vault credit unchanged
//   4. deletes the key again (KEEP_KEY=1 keeps it)
import { KeyPair, KeyPairSigner, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";

const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = process.env.VAULT_CONTRACT ?? "launch-vault.osl-launchpad-5786.testnet";
const HOME = process.env.HOME!;
const PROVIDER = process.env.BYOK_PROVIDER ?? "ollama";
const KEY = process.env[process.env.BYOK_KEY_ENV ?? "OLLAMA_API_KEY"] ?? "";
const rpc = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fmt = (y: bigint) => (Number(y) / 1e24).toFixed(5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const credit = async (id: string) => BigInt((await rpc.callFunction({ contractId: VAULT, method: "get_balance", args: { account_id: id } })) as string);

async function login(file: string) {
  const k = JSON.parse(readFileSync(file, "utf8")) as { account_id: string; private_key: string };
  const kp = KeyPair.fromString(k.private_key as KeyPairString);
  const message = `Sign in to Yeetpad\naccount: ${k.account_id}\nissued: ${new Date().toISOString()}`;
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const sig = await new KeyPairSigner(kp).signNep413Message(k.account_id, { message, recipient: VAULT, nonce });
  const r = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: k.account_id, publicKey: kp.getPublicKey().toString(), signature: b64(sig.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }) });
  const j = (await r.json()) as { token?: string };
  if (!j.token) throw new Error(`sign-in ${k.account_id}: HTTP ${r.status}`);
  return { id: k.account_id, token: j.token };
}
async function call(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (KEY && text.includes(KEY)) throw new Error(`${method} ${path}: response contained the key!`);
  return { status: r.status, j: JSON.parse(text || "{}") as any };
}
let fails = 0;
const check = (ok: boolean, what: string, note = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${note ? ` — ${note}` : ""}`);
};

const health = (await (await fetch(`${API}/api/health`)).json()) as any;
check(health.byok === true, "health: key storage enabled", `network ${health.network}`);

const me = await login(process.env.E2E_KEY_FILE ?? `${HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`);
const other = await login(process.env.USER_KEY_FILE ?? `${HOME}/.secrets/near_osl-launchpad-5786.testnet.json`).catch(() => null);
if (other && other.id !== me.id) {
  const r = await call("PUT", "/api/admin/llm-key", other.token, { provider: "ollama", apiKey: "x".repeat(20) });
  check(r.status === 403, `non-admin ${other.id} can't set the platform key`, `HTTP ${r.status}`);
  const g = await call("GET", "/api/admin/llm-key", other.token);
  check(g.status === 403, "non-admin can't read the platform key info", `HTTP ${g.status}`);
}
const bad1 = await call("PUT", "/api/llm/key", me.token, { provider: "openai", apiKey: "x".repeat(20) });
check(bad1.status === 400, "unknown provider rejected", bad1.j.error);
const bad2 = await call("PUT", "/api/llm/key", me.token, { provider: "ollama", apiKey: "x".repeat(20), baseUrl: "https://example.com/v1" });
check(bad2.status === 400 && bad2.j.code === "url_not_allowed", "custom base URL rejected", bad2.j.error);
const inv = await call("PUT", "/api/llm/key", me.token, { provider: PROVIDER, apiKey: `invalid-key-${Date.now()}-abcdefgh` });
check(inv.status === 400 && inv.j.code === "key_invalid", "invalid key rejected and not stored", inv.j.error);
const after = await call("GET", "/api/llm/key", me.token);
check(after.j.key === null || after.j.key?.lastError === null, "invalid key didn't replace anything", JSON.stringify(after.j.key && { provider: after.j.key.provider, last4: after.j.key.last4 }));

if (!KEY) {
  console.log("SKIP  no provider key in env; stopping after the validation checks");
} else {
  const models = await call("POST", "/api/llm/models", me.token, { provider: PROVIDER, apiKey: KEY });
  check(models.status === 200 && models.j.models?.length > 0, "models fetched server-side with the key", `${models.j.models?.length} models, default ${models.j.defaultModel}`);
  const saved = await call("PUT", "/api/llm/key", me.token, { provider: PROVIDER, apiKey: KEY, ...(process.env.BYOK_MODEL ? { model: process.env.BYOK_MODEL } : {}) });
  check(saved.status === 200 && saved.j.key?.valid === true && saved.j.key.last4 === KEY.slice(-4), "key saved + validated (write-only summary)", `${saved.j.key?.providerLabel} · ${saved.j.key?.model} · …${saved.j.key?.last4} · fields ${Object.keys(saved.j.key ?? {}).join(",")}`);
  const before = await credit(me.id);
  const g = await call("POST", "/api/generate", me.token, { prompt: "a tiny test coin for a bring-your-own-key check", count: 1 });
  check(g.status === 200 && g.j.charged === "0" && g.j.keySource === "user" && !g.j.txHash, "generated 1 idea with the user's key, no charge", g.status === 200 ? `${g.j.idea?.name} ($${g.j.idea?.ticker}) via ${g.j.provider}/${g.j.model}` : `HTTP ${g.status} ${g.j.error}`);
  await sleep(4000);
  const after2 = await credit(me.id);
  check(after2 === before, "vault credit unchanged", `${fmt(before)} → ${fmt(after2)} NEAR`);
  if (process.env.KEEP_KEY !== "1") {
    const d = await call("DELETE", "/api/llm/key", me.token);
    const g2 = await call("GET", "/api/llm/key", me.token);
    check(d.status === 200 && g2.j.key === null, "key deleted");
  }
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);

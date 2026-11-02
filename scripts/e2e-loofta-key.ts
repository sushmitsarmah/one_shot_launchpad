// Live testnet check: save a real Loofta key through PUT /api/loofta/key for the e2e account and confirm it is
// stored write-only (only the last 4 characters come back) and that the payout route is "checkout" (key mode).
// The key is read from a file and never printed. Testnet never creates payment links (preview only).
// Usage: LOOFTA_KEY_FILE=~/.secrets/loofta_api_key_x [DELETE=1] bun e2e-loofta-key.ts
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";

const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = "launch-vault.osl-launchpad-5786.testnet";
const k = JSON.parse(readFileSync(`${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8"));
const who: string = k.account_id;
const kp = KeyPair.fromString(k.private_key as KeyPairString);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const file = (process.env.LOOFTA_KEY_FILE ?? "").replace(/^~/, process.env.HOME ?? "");
const apiKey = file ? readFileSync(file, "utf8").trim() : "";
if (!process.env.DELETE && !apiKey) throw new Error("set LOOFTA_KEY_FILE");
const redact = (s: string) => (apiKey ? s.split(apiKey).join("[REDACTED]") : s);
const check = (label: string, ok: boolean, extra = "") => console.log(redact(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` ${extra}` : ""}`));

const message = `Sign in to Yeetpad\naccount: ${who}\nissued: ${new Date().toISOString()}`;
const nonce = crypto.getRandomValues(new Uint8Array(32));
const sig = await new KeyPairSigner(kp).signNep413Message(who, { message, recipient: VAULT, nonce });
const sr = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: who, publicKey: kp.getPublicKey().toString(), signature: b64(sig.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }) });
const token = ((await sr.json()) as any).token;
const req = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let j: any = {};
  try {
    j = JSON.parse(text);
  } catch {}
  return { status: r.status, j, text };
};
const leaks = (t: string) => !!apiKey && (t.includes(apiKey) || t.includes(apiKey.slice(0, -4)));

if (process.env.DELETE) {
  const d = await req("DELETE", "/api/loofta/key");
  check("key deleted", d.status === 200 && d.j.key === null, `(route=${d.j.route})`);
  process.exit(0);
}
const put = await req("PUT", "/api/loofta/key", { apiKey });
check("real key accepted by Loofta and saved", put.status === 200 && put.j.key?.valid === true, `(${put.status} ${put.j.error ?? ""})`);
check("response is masked (last 4 only)", put.j.key?.last4 === apiKey.slice(-4) && !leaks(put.text), `(…${put.j.key?.last4})`);
const s = await req("GET", "/api/loofta/settings");
check("settings: key mode", s.j.route === "checkout" && s.j.key?.valid === true && !leaks(s.text), `(route=${s.j.route} key=…${s.j.key?.last4} valid=${s.j.key?.valid} network=${s.j.network})`);
const t = await req("POST", "/api/loofta/key/test");
check("key re-test passes", t.status === 200 && t.j.ok === true && !leaks(t.text), `(${t.status})`);
const ls = await fetch(`${API}/api/launches/${who}`);
check("key not in public launches list", !leaks(await ls.text()));

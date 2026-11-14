// Admin kill switch for an Autopilot agent (README "Autopilot agent"). Signs in as an admin (full-access key file).
//   bun run agent:kill on  [account] [reason...]   # pause: every gated API call by the agent now fails (423)
//   bun run agent:kill off [account]               # resume
//   bun run agent:kill status
// ADMIN_KEY_FILE defaults to the e2e admin key. The same switch is POST /api/admin/agent/kill { account, paused }.
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";

const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = process.env.VAULT_CONTRACT ?? "launch-vault.osl-launchpad-5786.testnet";
const [cmd = "status", account = "yeetpad-autopilot.testnet", ...why] = process.argv.slice(2);
const k = JSON.parse(readFileSync(process.env.ADMIN_KEY_FILE ?? `${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8")) as { account_id: string; private_key: string };
const kp = KeyPair.fromString(k.private_key as KeyPairString);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const message = `Sign in to Yeetpad\naccount: ${k.account_id}\nissued: ${new Date().toISOString()}`;
const nonce = crypto.getRandomValues(new Uint8Array(32));
const sig = await new KeyPairSigner(kp).signNep413Message(k.account_id, { message, recipient: VAULT, nonce });
const sr = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: k.account_id, publicKey: kp.getPublicKey().toString(), signature: b64(sig.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }) });
const { token } = (await sr.json()) as { token: string };
const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
if (cmd === "on" || cmd === "off") {
  const r = await fetch(`${API}/api/admin/agent/kill`, { method: "POST", headers: h, body: JSON.stringify({ account, paused: cmd === "on", reason: why.join(" ") || null }) });
  console.log(r.status, JSON.stringify(await r.json()));
} else {
  const r = await fetch(`${API}/api/admin/agents`, { headers: h });
  console.log(r.status, JSON.stringify(await r.json(), null, 2));
}

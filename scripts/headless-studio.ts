// Headless render check of the Studio (count picker, ideas, My tokens tab) with a real session for the e2e account.
// Usage: SITE=http://localhost:4321 bun headless-studio.ts   (needs google-chrome; the token never leaves memory)
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const SITE = process.env.SITE ?? "http://localhost:4321";
const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = "launch-vault.osl-launchpad-5786.testnet";
const k = JSON.parse(readFileSync(process.env.E2E_KEY_FILE ?? `${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8"));
const kp = KeyPair.fromString(k.private_key as KeyPairString);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const message = `Sign in to Yeetpad\naccount: ${k.account_id}\nissued: ${new Date().toISOString()}`;
const nonce = crypto.getRandomValues(new Uint8Array(32));
const signed = await new KeyPairSigner(kp).signNep413Message(k.account_id, { message, recipient: VAULT, nonce });
const sr = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: k.account_id, publicKey: kp.getPublicKey().toString(), signature: b64(signed.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }) });
const sess = await sr.json();
if (!sr.ok) throw new Error(`sign-in ${sr.status}`);

const port = 9333;
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1600,1200", "about:blank"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find((t: any) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
  const j = JSON.parse(String(m.data));
  if (j.id && pending.has(j.id)) pending.get(j.id)!(j.result ?? j.error), pending.delete(j.id);
};
const cdp = (method: string, params: any = {}) => new Promise<any>((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr: string) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr: string, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evalJs(expr)) return true; await sleep(500); } return false; };

await cdp("Page.enable");
await cdp("Page.navigate", { url: `${SITE}/app/` });
await sleep(1500);
await evalJs(`localStorage.setItem("signedAccountId", ${JSON.stringify(k.account_id)});
  localStorage.setItem("near-wallet-selector:selectedWalletId", JSON.stringify("my-near-wallet"));
  localStorage.setItem("osl.session", ${JSON.stringify(JSON.stringify(sess))}); true`);
await cdp("Page.reload");
const out: Record<string, unknown> = {};
out.picker = await waitFor(`!!document.querySelector('.count-pick')`);
out.presets = await evalJs(`[...document.querySelectorAll('.count-pick button')].map(b => b.textContent).join(",")`);
out.custom = await evalJs(`!!document.querySelector('input.count-custom')`);
// custom 250 clamps to 100 on blur
await evalJs(`(() => { const i = document.querySelector('input.count-custom'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '250'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(300);
out.genButton = await evalJs(`[...document.querySelectorAll('.s-gen button')].map(b => b.textContent).find(t => /Generate/.test(t))`);
out.costLine = await evalJs(`document.querySelector('.s-gen p.muted.small:last-of-type')?.textContent`);
out.tabs = await evalJs(`[...document.querySelectorAll('.studio-tabs button')].map(b => b.textContent).join(" | ")`);
await evalJs(`[...document.querySelectorAll('.studio-tabs button')].find(b => /My tokens/.test(b.textContent)).click(); true`);
out.tokensTable = await waitFor(`!!document.querySelector('.tokens-table tbody tr td:not(.admin-empty)')`, 30000);
out.tokensRows = await evalJs(`document.querySelectorAll('.tokens-table tbody tr').length`);
out.totals = await evalJs(`document.querySelector('.tokens-dash .admin-stats')?.textContent`);
out.hash = await evalJs(`location.hash`);
console.log(JSON.stringify(out, null, 2));
ws.close();
chrome.kill();
process.exit(0);

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
// Delete dialog (opened and cancelled; nothing is deleted)
await evalJs(`[...document.querySelectorAll('.tokens-table tbody tr')].find(r => /pool ↗/.test(r.textContent)).querySelector('button.danger').click(); true`);
await waitFor(`!!document.querySelector('.danger-dialog') && !/Checking your Rhea/.test(document.querySelector('.danger-dialog').textContent)`, 20000);
out.deleteDialog = await evalJs(`(() => { const d = document.querySelector('.danger-dialog'); return { stays: /stays on the NEAR blockchain/.test(d.textContent), offline: /go(es)? offline/.test(d.textContent), liquidity: (d.querySelector('label.pick')?.textContent ?? d.querySelector('.del-facts li:last-child')?.textContent ?? '').trim().slice(0, 90), confirm: [...d.querySelectorAll('button')].map(b => b.textContent).join(' | ') }; })()`);
await evalJs(`[...document.querySelectorAll('.danger-dialog button')].find(b => b.textContent === 'Cancel').click(); true`);
out.showDeletedToggle = await evalJs(`!!document.querySelector('.tokens-dash input[type=checkbox]') && /Show deleted/.test(document.querySelector('.tokens-dash').textContent)`);

// ---- review/edit: preload a draft of 8 ideas (no generation spend), edit inline, check validation + persistence ----
const mk = (i: number) => ({ name: `Draft Idea ${i}`, ticker: `drafttk${i}`, tagline: "a draft tagline", description: "A draft description long enough.", colors: { primary: "#ff3d8b", secondary: "#2b2bff", accent: "#ffd23f", background: "#fff6e9", text: "#111111" } });
const ideas = Array.from({ length: 8 }, (_, i) => mk(i + 1));
await evalJs(`localStorage.setItem("yeetpad.ideasDraft", ${JSON.stringify(JSON.stringify({ v: 1, account: k.account_id, prompt: "draft check", ideas, originals: ideas, picked: ideas.map(() => true) }))}); localStorage.removeItem("yeetpad.launchRun"); history.replaceState(null, "", "/app/"); true`);
await cdp("Page.reload");
const setVal = (sel: string, v: string) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const launchBtn = `[...document.querySelectorAll('.s-launch button')].find(b => /Launch/.test(b.textContent))`;
out.rows = (await waitFor(`document.querySelectorAll('.idea-row').length === 8`)) && 8;
out.launchEnabledInitially = await evalJs(`!${launchBtn}.disabled`);
await evalJs(`document.querySelector('.idea-row [aria-label^="edit "]').click(); true`);
await sleep(200);
out.editorOpen = await evalJs(`!!document.querySelector('.idea-row.open .idea-edit')`);
await setVal('.idea-row.open [data-field="name"]', "X");
await setVal('.idea-row.open [data-field="ticker"]', "drafttk2");
await sleep(300);
out.inlineErrors = await evalJs(`[...document.querySelectorAll('.idea-row.open .err-inline')].map(e => e.textContent)`);
out.launchDisabledWhenInvalid = await evalJs(`${launchBtn}.disabled`);
out.whichInvalid = await evalJs(`document.querySelector('.s-launch .error')?.textContent`);
await setVal('.idea-row.open [data-field="name"]', "Renamed By Hand");
await setVal('.idea-row.open [data-field="ticker"]', "handtk");
await setVal('.idea-row.open [data-field="description"]', "Hand-written description for this token.");
await sleep(400);
out.launchEnabledAfterFix = await evalJs(`!${launchBtn}.disabled`);
out.sitePreview = await evalJs(`document.querySelector('.idea-row.open .idea-edit label .muted')?.textContent`);
await sleep(500);
await cdp("Page.reload");
await waitFor(`document.querySelectorAll('.idea-row').length === 8`);
out.persistedAfterReload = await evalJs(`document.querySelector('.idea-row .ir-name')?.textContent + " / $" + document.querySelector('.idea-row .ir-tk input')?.value + " / edited badge: " + !!document.querySelector('.idea-row .badge')`);
await evalJs(`document.querySelector('.idea-row [aria-label^="edit "]').click(); true`);
await sleep(200);
await evalJs(`[...document.querySelectorAll('.idea-row.open button')].find(b => /Reset to original/.test(b.textContent)).click(); true`);
await sleep(200);
out.afterReset = await evalJs(`document.querySelector('.idea-row .ir-name')?.textContent`);
await evalJs(`localStorage.removeItem("yeetpad.ideasDraft"); true`);
console.log(JSON.stringify(out, null, 2));
ws.close();
chrome.kill();
process.exit(0);

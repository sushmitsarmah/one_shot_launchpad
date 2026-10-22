// Headless check of a token page with NEAR Intents enabled (desktop + mobile width), no wallet, no funds.
// Usage: SITE=https://yeetpad.fun SLUG=neon-paw-arcade-2 bun headless-token.ts
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const SITE = process.env.SITE ?? "https://yeetpad.fun";
const SLUG = process.env.SLUG ?? "neon-paw-arcade-2";
const port = 9334;
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1280,1600", "about:blank"], { stdio: "ignore" });
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
const setVal = (sel: string, v: string) => evalJs(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const shot = async (name: string) => writeFileSync(`/tmp/${name}.png`, Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));

await cdp("Page.enable");
await cdp("Page.navigate", { url: `${SITE}/t/${SLUG}?cb=${Date.now()}` });
const out: Record<string, unknown> = {};
out.widget = await waitFor(`!!document.querySelector('.tk-intents select option')`, 30000);
out.title = await evalJs(`document.querySelector('.tk-intents h2')?.textContent`);
out.tabs = await evalJs(`[...document.querySelectorAll('.tki-tab')].map(b => b.textContent).join(' | ')`);
out.note = await evalJs(`document.querySelector('.tki-note')?.textContent`);
out.assets = await evalJs(`document.querySelectorAll('.tk-intents select option').length`);
out.firstAssets = await evalJs(`[...document.querySelectorAll('.tk-intents select option')].slice(0, 6).map(o => o.textContent).join(', ')`);
out.selected = await evalJs(`document.querySelector('.tk-intents select').selectedOptions[0].textContent`);
out.yeetpadBranding = await evalJs(`/yeetpad/i.test(document.querySelector('.tk-intents').textContent)`);
out.foot = await evalJs(`document.querySelector('.tki-foot')?.textContent`);
await setVal(".tk-intents input[aria-label=amount]", "5");
await evalJs(`[...document.querySelectorAll('.tk-intents button')].find(b => b.textContent === 'Get quote').click(); true`);
out.quoted = await waitFor(`!document.querySelector('.tki-quote').hidden`, 20000);
await sleep(2500);
out.quote = await evalJs(`document.querySelector('.tki-quote').innerText`);
out.msg = await evalJs(`document.querySelector('.tki-msg').textContent`);
out.depositButtonVisible = await evalJs(`(() => { const b = [...document.querySelectorAll(".tk-intents button")].find(b => b.textContent === "Get deposit address"); return !!b && getComputedStyle(b).display !== "none"; })()`);
out.depositBoxShown = await evalJs(`!document.querySelector('.tki-deposit').hidden`);
out.step2 = await evalJs(`document.querySelector('.tki-step2 h3')?.textContent`);
out.primaryTint = await evalJs(`getComputedStyle(document.querySelector('.tki-tab.is-on') ?? document.body).backgroundColor + ' vs --tk-primary ' + getComputedStyle(document.getElementById('tk')).getPropertyValue('--tk-primary')`);
await shot("intents-desktop");
// tip tab
await evalJs(`[...document.querySelectorAll('.tki-tab')].find(b => /Tip/.test(b.textContent))?.click(); true`);
await sleep(300);
out.tipTitle = await evalJs(`document.querySelector('.tk-intents h2')?.textContent`);
out.tipHidesAccount = await evalJs(`getComputedStyle(document.querySelector('.tk-intents input[aria-label="your NEAR account"]').closest('label')).display === 'none'`);
out.refundHiddenOnTestnet = await evalJs(`getComputedStyle(document.querySelector('.tk-intents input[aria-label="refund address"]').closest('label')).display === 'none'`);
// mobile
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(800);
out.mobileOverflow = await evalJs(`document.documentElement.scrollWidth > window.innerWidth + 1`);
await evalJs(`document.querySelector('.tk-intents').scrollIntoView(); true`);
await shot("intents-mobile");
console.log(JSON.stringify(out, null, 2));
chrome.kill();
process.exit(0);

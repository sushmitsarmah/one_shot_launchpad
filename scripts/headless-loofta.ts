// Headless check of a token page with Loofta enabled (desktop + mobile width), no wallet, no funds.
// Loofta is live on every network: CLICK=1 clicks "Pay with Loofta", which creates a real (unpaid) payment link and
// opens Loofta in a new tab; never pay it. Without CLICK only the form is checked. Usage: SITE=https://yeetpad.fun SLUG=neon-paw-arcade-2 bun headless-loofta.ts
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const SITE = process.env.SITE ?? "https://yeetpad.fun";
const SLUG = process.env.SLUG ?? "neon-paw-arcade-2";
const port = 9335;
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1280,1600", "about:blank"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page0 = targets.find((t: any) => t.type === "page");
const ws = new WebSocket(page0.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
const opened: string[] = [];
ws.onmessage = (m) => {
  const j = JSON.parse(String(m.data));
  if (j.id && pending.has(j.id)) pending.get(j.id)!(j.result ?? j.error), pending.delete(j.id);
  if (j.method === "Target.targetCreated" && j.params.targetInfo.type === "page" && j.params.targetInfo.targetId !== page0.id) opened.push(j.params.targetInfo.url);
};
const cdp = (method: string, params: any = {}) => new Promise<any>((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr: string) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr: string, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evalJs(expr)) return true; await sleep(500); } return false; };
const setVal = (sel: string, v: string) => evalJs(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const shot = async (name: string) => writeFileSync(`/tmp/${name}.png`, Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));

await cdp("Page.enable");
await cdp("Target.setDiscoverTargets", { discover: true });
await cdp("Page.navigate", { url: `${SITE}/t/${SLUG}?cb=${Date.now()}` });
const out: Record<string, unknown> = {};
out.widget = await waitFor(`!!document.querySelector('.tk-loofta .tkl-pay')`, 30000);
out.title = await evalJs(`document.querySelector('.tk-loofta h2')?.textContent`);
out.intro = await evalJs(`document.querySelector('.tk-loofta .tki-small')?.textContent`);
out.note = await evalJs(`document.querySelector('.tk-loofta .tki-note')?.textContent`);
out.foot = await evalJs(`document.querySelector('.tk-loofta .tki-foot')?.textContent`);
out.intentsStillThere = await evalJs(`!!document.querySelector('.tk-intents:not(.tk-loofta)')`);
out.yeetpadBranding = await evalJs(`/yeetpad/i.test(document.querySelector('.tk-loofta').textContent)`);
out.emailInHtml = await evalJs(`/@example\\.com/.test(document.documentElement.outerHTML)`);
await setVal(".tk-loofta input[aria-label='amount in USD']", "0.5");
out.lowAmountMsg = await evalJs(`document.querySelector('.tk-loofta .tki-msg').textContent`);
out.lowAmountDisabled = await evalJs(`document.querySelector('.tk-loofta .tkl-pay').disabled`);
await setVal(".tk-loofta input[aria-label='amount in USD']", "5");
if (process.env.CLICK) {
  await evalJs(`document.querySelector('.tk-loofta .tkl-pay').click(); true`);
  await waitFor(`/opened|Couldn't/.test(document.querySelector('.tk-loofta .tki-msg').textContent)`, 15000);
  out.clickMsg = await evalJs(`document.querySelector('.tk-loofta .tki-msg').textContent`);
  out.newTabsOpened = opened; // the page itself is excluded
}
await shot("loofta-desktop");
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(800);
out.mobileOverflow = await evalJs(`document.documentElement.scrollWidth > window.innerWidth + 1`);
await evalJs(`document.querySelector('.tk-loofta').scrollIntoView(); true`);
await shot("loofta-mobile");
console.log(JSON.stringify(out, null, 2));
chrome.kill();
process.exit(0);

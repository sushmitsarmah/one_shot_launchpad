// Headless check of the Swarm Market page (/swarm): rounds, agents, chart and tx links render from testnet.
// Usage: SITE=https://yeetpad.fun bun headless-swarm.ts   (screenshots in /tmp/swarm-*.png)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const SITE = process.env.SITE ?? "https://yeetpad.fun";
const port = 9336;
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
await cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1400, deviceScaleFactor: 1, mobile: false });
await cdp("Page.navigate", { url: `${SITE}/swarm/?cb=${Date.now()}` });
const out: Record<string, unknown> = {};
out.rounds = await waitFor(`document.querySelectorAll('#sw-rounds details').length > 0`, 30000);
await waitFor(`document.querySelectorAll('#sw-agents tbody tr').length === 25`, 20000);
out.roundCount = await evalJs(`document.querySelectorAll('#sw-rounds details').length`);
out.stats = await evalJs(`[...document.querySelectorAll('.sw-stat')].map(s => s.textContent.trim().replace(/\\s+/g, ' ')).join(' | ')`);
out.now = await evalJs(`document.querySelector('#now-phase').textContent + ' / ' + document.querySelector('#now-detail').textContent`);
out.agents = await evalJs(`document.querySelectorAll('#sw-agents tbody tr').length`);
out.firstRoundBids = await evalJs(`document.querySelectorAll('#sw-rounds details[open] tbody')[1]?.querySelectorAll('tr').length`);
out.txLinks = await evalJs(`document.querySelectorAll('#sw-rounds a[href*="/txns/"]').length`);
out.chartPoints = await evalJs(`document.querySelectorAll('#sw-chart circle').length`);
out.overflowX = await evalJs(`document.documentElement.scrollWidth > window.innerWidth`);
await shot("swarm-desktop");
await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 2, mobile: true });
await sleep(1500);
out.mobileOverflowX = await evalJs(`document.documentElement.scrollWidth > window.innerWidth`);
await shot("swarm-mobile");
console.log(JSON.stringify(out, null, 1));
ws.close();
chrome.kill();
process.exit(0);

// Live testnet check of Delete/Restore and the Rhea liquidity pull, signed with the e2e key (no browser wallet).
// Usage: TICKER=<ticker> [LPT=<lpt_id>] bun e2e-delete.ts
//   1. POST /api/tokens/delete -> /api/site 410, yeetpad.fun/t/<slug> 410, hidden from launches; then restore -> 200.
//   2. LPT given: signs the same DCL remove_liquidity call the Studio builds (removeLiquidityCall) for that position.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { minsFor, quotePosition, removeLiquidityCall, slippageBps, type DclPosition } from "../apps/studio-web/src/lib/dcl";

const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const SITE = process.env.SITE_URL ?? "https://yeetpad.fun";
const VAULT = "launch-vault.osl-launchpad-5786.testnet";
const DCL = process.env.DCL_CONTRACT ?? "dclv2.ref-dev.testnet";
const k = JSON.parse(readFileSync(process.env.E2E_KEY_FILE ?? `${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8"));
const who: string = k.account_id;
const kp = KeyPair.fromString(k.private_key as KeyPairString);
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const acct = new Account(who, provider, k.private_key as KeyPairString);
const fmt = (y: bigint) => (Number(y) / 1e24).toFixed(5);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wallet = async () => BigInt((await provider.viewAccount({ accountId: who })).amount);
const ticker = process.env.TICKER!;

const message = `Sign in to Yeetpad\naccount: ${who}\nissued: ${new Date().toISOString()}`;
const nonce = crypto.getRandomValues(new Uint8Array(32));
const sig = await new KeyPairSigner(kp).signNep413Message(who, { message, recipient: VAULT, nonce });
const sr = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: who, publicKey: kp.getPublicKey().toString(), signature: b64(sig.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }) });
const token = ((await sr.json()) as any).token;
const post = async (p: string, body: unknown) => {
  const r = await fetch(`${API}${p}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, j: (await r.json()) as any };
};
const page = async (slug: string) => (await fetch(`${SITE}/t/${slug}?cb=${Date.now()}`, { headers: { "user-agent": "curl/8" }, redirect: "manual" })).status;
const inLaunches = async (q = "") => ((await (await fetch(`${API}/api/launches/${who}?limit=50${q}`)).json()) as any).launches.find((l: any) => l.ticker === ticker);
const until = async (fn: () => Promise<boolean>, ms = 90_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(4000); } return false; };

const w0 = await wallet();
if (ticker) {
  const s0 = (await (await fetch(`${API}/api/site/${ticker}`)).json()) as any;
  const slug = s0.siteConfig.slug ?? ticker;
  console.log(`token $${ticker.toUpperCase()} ${SITE}/t/${slug}: page ${await page(slug)}`);
  const d = await post("/api/tokens/delete", { tokens: [ticker] });
  console.log(`delete -> ${d.status} ${JSON.stringify(d.j.results)}`);
  console.log(`  /api/site -> ${(await fetch(`${API}/api/site/${slug}`)).status}`);
  console.log(`  page 410 (KV may take up to ~60 s): ${await until(async () => (await page(slug)) === 410)}`);
  const html = await (await fetch(`${SITE}/t/${slug}?cb=${Date.now()}`, { headers: { "user-agent": "curl/8" } })).text();
  console.log(`  page says: ${/taken down by its creator/.test(html)}`);
  console.log(`  hidden from launches: ${!(await inLaunches())} · listed with includeDeleted: ${!!(await inLaunches("&includeDeleted=1"))?.deletedAt}`);
  const r = await post("/api/tokens/restore", { tokens: [ticker] });
  console.log(`restore -> ${r.status} ${JSON.stringify(r.j.results)}`);
  console.log(`  /api/site -> ${(await fetch(`${API}/api/site/${slug}`)).status} · page 200: ${await until(async () => (await page(slug)) === 200)} · back in launches: ${!!(await inLaunches())}`);
}
if (process.env.LPT) {
  const lp = (await provider.callFunction({ contractId: DCL, method: "get_liquidity", args: { lpt_id: process.env.LPT } })) as DclPosition | null;
  if (!lp || lp.owner_id !== who || BigInt(lp.amount) === 0n) console.log(`position ${process.env.LPT}: gone, empty or not ours; skipped`);
  else {
    const q = await quotePosition((c, m, a) => provider.callFunction({ contractId: c, method: m, args: a as Record<string, unknown> }), DCL, lp);
    if (!q.ok) throw new Error(`couldn't quote ${process.env.LPT}: ${q.error}`);
    const call = removeLiquidityCall(DCL, lp, "lp", minsFor(q, slippageBps(1)!));
    const tk = lp.pool_id.split("|").find((t) => !t.startsWith("wrap."))!;
    const bal0 = BigInt((await provider.callFunction({ contractId: tk, method: "ft_balance_of", args: { account_id: who } })) as string);
    const before = await wallet();
    const res = await acct.signAndSendTransaction({ receiverId: call.receiverId, actions: [actions.functionCall(call.methodName, call.args, BigInt(call.gas), BigInt(call.deposit))] });
    const fails = res.receipts_outcome.filter((o: any) => o.outcome.status.Failure);
    const bal1 = BigInt((await provider.callFunction({ contractId: tk, method: "ft_balance_of", args: { account_id: who } })) as string);
    const after = (await provider.callFunction({ contractId: DCL, method: "get_liquidity", args: { lpt_id: process.env.LPT } }).catch(() => null)) as DclPosition | null;
    console.log(`remove_liquidity ${process.env.LPT}: tx https://testnet.nearblocks.io/txns/${res.transaction.hash} · failed receipts ${fails.length}`);
    console.log(`  position after: ${after ? `amount ${after.amount}` : "gone"} · ${tk} to wallet: ${bal1 - bal0} · wallet NEAR delta ${fmt((await wallet()) - before)}`);
  }
}
console.log(`total wallet delta ${fmt((await wallet()) - w0)} NEAR`);

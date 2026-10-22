// Live testnet check that hand-edited ideas launch as edited: generate 2 ideas, edit name/ticker/tagline/description
// (validated with the Studio's runErrors), launch with venue None, then read the factory record, token metadata and site.
// Spends ~0.02 (ideas) + ~0.076 per token in credit, plus relayer gas. Usage: bun e2e-edited.ts
import { JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { hasErrors, runErrors, type LaunchIdea } from "../packages/schema/src/index";

const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = "launch-vault.osl-launchpad-5786.testnet";
const FACTORY = "ft-factory.osl-launchpad-5786.testnet";
const RELAYER = "osl-launchpad-5786.testnet";
const k = JSON.parse(readFileSync(process.env.E2E_KEY_FILE ?? `${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8"));
const who: string = k.account_id;
const kp = KeyPair.fromString(k.private_key as KeyPairString);
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const fmt = (y: bigint) => (Number(y) / 1e24).toFixed(5);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const view = (c: string, m: string, a: object) => provider.callFunction({ contractId: c, method: m, args: a }) as Promise<any>;
const credit = async () => BigInt(await view(VAULT, "get_balance", { account_id: who }));
const wallet = async (a: string) => BigInt((await provider.viewAccount({ accountId: a })).amount);

const message = `Sign in to Yeetpad\naccount: ${who}\nissued: ${new Date().toISOString()}`;
const nonce = crypto.getRandomValues(new Uint8Array(32));
const sig = await new KeyPairSigner(kp).signNep413Message(who, { message, recipient: VAULT, nonce });
const sr = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: who, publicKey: kp.getPublicKey().toString(), signature: b64(sig.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }) });
const token = ((await sr.json()) as any).token;
if (!token) throw new Error("sign-in failed");
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = (await r.json()) as any;
  if (!r.ok) throw new Error(`${path} ${r.status}: ${j.error}`);
  return j;
};

const c0 = await credit();
const r0 = await wallet(RELAYER);
console.log(`credit ${fmt(c0)} NEAR`);
const g = await post("/api/generate", { prompt: "lighthouse keepers who moonlight as DJs", count: 2, seq: 7 });
const stamp = Date.now().toString(36).slice(-4);
const edited: LaunchIdea[] = (g.ideas as LaunchIdea[]).map((x, i) => ({
  ...x,
  name: `Hand Edited ${i ? "Beacon" : "Lamp"} ${stamp}`,
  ticker: `hedit${i}${stamp}`.slice(0, 16),
  tagline: `Edited tagline ${i + 1} (${stamp})`,
  description: `This description was edited by hand in the Studio review list before launch (${stamp}, #${i + 1}).`,
}));
console.log("generated:", g.ideas.map((x: LaunchIdea) => `${x.name} $${x.ticker}`).join(" | "));
const errs = runErrors(edited);
if (errs.some(hasErrors)) throw new Error(`edited ideas invalid: ${JSON.stringify(errs)}`);
const r = await post("/api/launch/batch", { ideas: edited, listOn: "none" });
console.log(`launch tx ${r.txHash}`);
for (const [i, it] of r.results.entries()) {
  const e = edited[i];
  if (!it.ok) {
    console.log(`  ERR ${it.ticker}: ${it.error}`);
    continue;
  }
  const rec = await view(FACTORY, "get_token", { ticker: e.ticker }).catch(() => null);
  const md = await view(it.tokenId, "ft_metadata", {});
  const site = (await (await fetch(`${API}/api/site/${it.slug}`)).json()) as any;
  const page = await (await fetch(`https://yeetpad.fun/t/${it.slug}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/130" } })).text();
  const chainSite = rec?.site ? JSON.parse(rec.site) : null;
  console.log(`  ok $${e.ticker.toUpperCase()} https://yeetpad.fun/t/${it.slug}  ${it.tokenId}`);
  console.log(`     on-chain ft_metadata: name="${md.name}" symbol="${md.symbol}" (match: ${md.name === e.name && md.symbol === e.ticker.toUpperCase()})`);
  console.log(`     factory record site.description match: ${chainSite ? chainSite.description === e.description && chainSite.tagline === e.tagline : "n/a (no get_token view)"}`);
  console.log(`     site config: name="${site.siteConfig.branding.name}" desc match: ${site.siteConfig.branding.description === e.description} · page 200 has name: ${page.includes(e.name)}`);
}
const c1 = await credit();
const r1 = await wallet(RELAYER);
console.log(`credit spent ${fmt(c0 - c1)} (now ${fmt(c1)}); relayer gas ${fmt(r0 - r1)} (now ${fmt(r1)})`);

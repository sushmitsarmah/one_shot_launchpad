// Live check of NEAR Intents on token pages (no funds move). 1Click is always mainnet. Optionally sets the e2e
// creator's mainnet tip payout account (PAYOUT=name.near; PAYOUT=- clears), bulk-enables Intents for TICKERS,
// reads the page config, gets live 1Click quotes through our API proxy (price-only dry quotes unless REAL=1, which
// asks for a binding quote with a deposit address; never deposit), a dry buy quote
// and the status proxy, then (if DISABLE=1) turns it off. Usage: TICKERS=a,b [PAYOUT=x.near] [REAL=1] [DISABLE=1] bun e2e-intents.ts
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";

const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = "launch-vault.osl-launchpad-5786.testnet";
const k = JSON.parse(readFileSync(`${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8"));
const who: string = k.account_id;
const kp = KeyPair.fromString(k.private_key as KeyPairString);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const tickers = (process.env.TICKERS ?? "").split(",").filter(Boolean);

const message = `Sign in to Yeetpad\naccount: ${who}\nissued: ${new Date().toISOString()}`;
const nonce = crypto.getRandomValues(new Uint8Array(32));
const sig = await new KeyPairSigner(kp).signNep413Message(who, { message, recipient: VAULT, nonce });
const sr = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: who, publicKey: kp.getPublicKey().toString(), signature: b64(sig.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }) });
const token = ((await sr.json()) as any).token;
const post = async (p: string, body: unknown, auth = true) => {
  const r = await fetch(`${API}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, j: (await r.json()) as any };
};

if (process.env.PAYOUT) {
  const r = await fetch(`${API}/api/intents/payout`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ account: process.env.PAYOUT === "-" ? null : process.env.PAYOUT }) });
  console.log(`intents/payout -> ${r.status} ${JSON.stringify(await r.json())}`);
}
const on = await post("/api/tokens/intents", { tokens: tickers, intents: { enabled: !process.env.DISABLE, mode: "both", tipAsset: "usdc" } });
console.log(`tokens/intents -> ${on.status} ${JSON.stringify(on.j.results)}`);
for (const t of tickers) {
  const s = (await (await fetch(`${API}/api/site/${t}`)).json()) as any;
  console.log(`${t}: https://yeetpad.fun/t/${s.siteConfig.slug ?? t} intents=${JSON.stringify(s.intents)} network=${s.network} rhea=${s.rhea?.poolId ?? null}`);
}
if (process.env.DISABLE) process.exit(0);
const toks = ((await (await fetch(`${API}/api/intents/tokens`)).json()) as any).tokens as { assetId: string; symbol: string; blockchain: string }[];
console.log(`intents/tokens: ${toks.length} assets on ${new Set(toks.map((t) => t.blockchain)).size} chains`);
const usdcBase = toks.find((t) => t.symbol === "USDC" && t.blockchain === "base")!;
const btc = toks.find((t) => t.symbol === "BTC" && t.blockchain === "btc")!;
const q1 = await post("/api/intents/quote", { site: tickers[0], mode: "buy", originAsset: usdcBase.assetId, amount: "5000000", dry: true }, false);
console.log(`quote buy 5 USDC(Base)->wNEAR (dry): ${q1.status} ${q1.j.error ?? `out=${q1.j.amountOutFormatted} wNEAR ($${q1.j.amountOutUsd})`}`);
const real = !!process.env.REAL;
const q2 = await post("/api/intents/quote", { site: tickers[0], mode: "tip", originAsset: btc.assetId, amount: "10000", dry: !real, ...(real ? { refundTo: process.env.REFUND_BTC ?? "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" } : {}) }, false);
console.log(`quote tip 0.0001 BTC->USDC (${real ? "binding" : "dry"}): ${q2.status} ${q2.j.error ?? `preview=${q2.j.preview} dry=${q2.j.dry} out=${q2.j.amountOutFormatted} USDC ($${q2.j.amountOutUsd}) deposit=${q2.j.depositAddress ? "yes (do not send)" : "none"} dest=${q2.j.destinationAsset}`}`);
const bad = await post("/api/intents/quote", { site: tickers[0], mode: "tip", originAsset: "nep141:abc.factory.yeetpad.near", amount: "1" }, false);
console.log(`quote unsupported asset: ${bad.status} ${bad.j.error}`);
const st = await fetch(`${API}/api/intents/status?depositAddress=0x0000000000000000000000000000000000000001`);
console.log(`status (unknown address): ${st.status} ${((await st.json()) as any).error}`);

// Live check of Loofta "pay the creator" on token pages (no funds move). Loofta has no testnet: payments are real
// on every Yeetpad deployment. Signs in with the e2e account, checks that a bogus Loofta key is rejected by Loofta
// and not stored, optionally saves a payout target (PAYTO_EMAIL, e.g. an @example.com address), bulk-enables
// Loofta for TICKERS and reads the page config and the public launches list (the target must not appear).
// CHECKOUT=1 also asks for a real checkout: with a stored key that creates a real (unpaid) Loofta payment link and
// checks the URL opens with HTTP 200; never pay it. DISABLE=1 turns Loofta off; CLEAR_PAYTO=1 removes the target.
// Usage: TICKERS=ab6bpwo [PAYTO_EMAIL=x@example.com] [CHECKOUT=1] [SKIP_KEY=1] [DISABLE=1] [CLEAR_PAYTO=1] bun e2e-loofta.ts
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";

const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = "launch-vault.osl-launchpad-5786.testnet";
const k = JSON.parse(readFileSync(`${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8"));
const who: string = k.account_id;
const kp = KeyPair.fromString(k.private_key as KeyPairString);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const tickers = (process.env.TICKERS ?? "").split(",").filter(Boolean);
const email = process.env.PAYTO_EMAIL ?? "";
const check = (label: string, ok: boolean, extra = "") => console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` ${extra}` : ""}`);

const message = `Sign in to Yeetpad\naccount: ${who}\nissued: ${new Date().toISOString()}`;
const nonce = crypto.getRandomValues(new Uint8Array(32));
const sig = await new KeyPairSigner(kp).signNep413Message(who, { message, recipient: VAULT, nonce });
const sr = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: who, publicKey: kp.getPublicKey().toString(), signature: b64(sig.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }) });
const token = ((await sr.json()) as any).token;
const req = async (method: string, p: string, body?: unknown, auth = true) => {
  const r = await fetch(`${API}${p}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let j: any = {};
  try {
    j = JSON.parse(text);
  } catch {}
  return { status: r.status, j, text };
};

const s0 = await req("GET", "/api/loofta/settings");
console.log(`settings -> ${s0.status} storage=${s0.j.enabled} route=${s0.j.route} key=${s0.j.key ? `…${s0.j.key.last4} valid=${s0.j.key.valid}` : "none"} payTo=${s0.j.payTo?.display ?? "none"} network=${s0.j.network}`);

if (!process.env.SKIP_KEY) {
  // A well-formed but bogus key: our API asks Loofta (GET /payment-links/<random>), Loofta answers 401, nothing is stored.
  const bogus = `lft_live_e2eBogus${Date.now()}`;
  const bad = await req("PUT", "/api/loofta/key", { apiKey: bogus });
  check("bogus Loofta key rejected, not stored", bad.status === 400 && /not saved/.test(bad.j.error ?? "") && !bad.text.includes(bogus), `(${bad.status} ${bad.j.error})`);
  const malformed = await req("PUT", "/api/loofta/key", { apiKey: "sk-123" });
  check("non-Loofta key format rejected", malformed.status === 400, `(${malformed.j.error})`);
}

if (!process.env.DISABLE && email) {
  const pt = await req("PUT", "/api/loofta/payto", { payTo: { kind: "email", value: email } });
  check("payout target saved (masked)", pt.status === 200 && pt.j.payTo?.display?.includes("•••") && !pt.text.includes(email), `(${pt.j.payTo?.display} route=${pt.j.route})`);
}
const on = await req("POST", "/api/tokens/loofta", { tokens: tickers, loofta: { enabled: !process.env.DISABLE } });
console.log(`tokens/loofta -> ${on.status} ${JSON.stringify(on.j.results)}`);
for (const t of tickers) {
  const r = await fetch(`${API}/api/site/${t}`);
  const text = await r.text();
  const s = JSON.parse(text);
  console.log(`${t}: https://yeetpad.fun/t/${s.siteConfig.slug ?? t} loofta=${JSON.stringify(s.loofta)} network=${s.network}`);
  if (email) check(`${t}: payout target not in /api/site`, !text.includes(email) && !text.includes(email.split("@")[0]));
  if (process.env.DISABLE) {
    check(`${t}: loofta off`, s.loofta === null);
    continue;
  }
  if (process.env.CHECKOUT) {
    const co = await req("POST", "/api/loofta/checkout", { site: s.siteConfig.slug ?? t, amount: Number(process.env.AMOUNT ?? 1), message: "e2e (do not pay)" }, false);
    const url: string | null = co.j.url ?? null;
    const host = url ? new URL(url).host : null;
    check(`${t}: live checkout (${co.j.route})`, co.status === 200 && co.j.preview === false && !!url && /^pay\.loofta\.(com|xyz)$/.test(host!), `(${co.status} ${host ?? co.j.error})`);
    if (url) {
      const op = await fetch(url, { redirect: "follow" });
      check(`${t}: checkout page opens`, op.status === 200, `(${op.status} ${new URL(op.url).host}${new URL(op.url).pathname.replace(/[^/]+$/, "…")})`);
    }
  }
  const bad = await req("POST", "/api/loofta/checkout", { site: t, amount: 0.5 }, false);
  check(`${t}: amount below $1 rejected`, bad.status === 400, `(${bad.j.error})`);
}
const ls = await fetch(`${API}/api/launches/${who}`);
const lsText = await ls.text();
const mine = (JSON.parse(lsText).launches as { ticker: string; loofta?: unknown }[]).filter((l) => tickers.includes(l.ticker));
console.log(`launches: ${mine.map((l) => `${l.ticker}=${JSON.stringify(l.loofta ?? null)}`).join(" ")}`);
if (email) check("payout target not in public launches list", !lsText.includes(email));
if (process.env.CLEAR_PAYTO) {
  const c = await req("PUT", "/api/loofta/payto", { payTo: null });
  console.log(`payout target cleared -> ${c.status} route=${c.j.route}`);
}

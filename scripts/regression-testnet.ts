// Full testnet regression of the live stack (yeetpad.fun + API worker + contracts), signed with real keys.
// Usage: bun regression-testnet.ts [--skip-launch] [--skip-admin-contract]
//   ADMIN_KEY_FILE (default ~/.secrets/near_osl-e2e-mvhxupmb.testnet.json): admin + creator
//   USER_KEY_FILE  (default ~/.secrets/near_osl-launchpad-5786.testnet.json): non-admin; also the contracts' owner
// Spends testnet NEAR: ~1.85 per token launched (4-6 launches), plus a little gas.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions as A, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HOME = process.env.HOME!;
const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const SITE = process.env.SITE_URL ?? "https://yeetpad.fun";
const VAULT = process.env.VAULT_CONTRACT ?? "launch-vault.osl-launchpad-5786.testnet";
const FACTORY = process.env.FT_FACTORY_CONTRACT ?? "ft-factory.osl-launchpad-5786.testnet";
const DCL = "dclv2.ref-dev.testnet";
const WNEAR = "wrap.testnet";
const TX = "https://testnet.nearblocks.io/txns/";
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const args = new Set(process.argv.slice(2));
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const fmt = (y: bigint | string) => (Number(BigInt(y)) / 1e24).toFixed(5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const view = (contractId: string, method: string, a: Record<string, unknown> = {}) => provider.callFunction({ contractId, method, args: a }) as Promise<any>;

type Who = { id: string; kp: KeyPair; acct: Account; key: string };
const load = (f: string): Who => {
  const k = JSON.parse(readFileSync(f, "utf8")) as { account_id: string; private_key: string };
  return { id: k.account_id, kp: KeyPair.fromString(k.private_key as KeyPairString), acct: new Account(k.account_id, provider, k.private_key as KeyPairString), key: k.private_key };
};
const admin = load(process.env.ADMIN_KEY_FILE ?? `${HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`);
const user = load(process.env.USER_KEY_FILE ?? `${HOME}/.secrets/near_osl-launchpad-5786.testnet.json`);

// ---------- result table ----------
const results: { area: string; check: string; ok: boolean | null; note: string }[] = [];
// ONLY=<regex> runs just the matching "<area> <check>" items (e.g. ONLY='Rhea \\(pool|contracts|venues').
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
async function check(area: string, name: string, fn: () => Promise<string | void>) {
  if (ONLY && !ONLY.test(`${area} ${name}`)) return;
  try {
    const note = (await fn()) ?? "";
    results.push({ area, check: name, ok: true, note });
    console.log(`PASS  [${area}] ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    const note = (e as Error).message.slice(0, 300);
    results.push({ area, check: name, ok: false, note });
    console.log(`FAIL  [${area}] ${name} — ${note}`);
  }
}
const skip = (area: string, name: string, note: string) => {
  results.push({ area, check: name, ok: null, note });
  console.log(`SKIP  [${area}] ${name} — ${note}`);
};
function assert(c: unknown, msg: string): asserts c {
  if (!c) throw new Error(msg);
}
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000, every = 3000): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out after ${ms / 1000}s${last ? `: ${(last as Error).message}` : ""}`);
}

// ---------- API helpers ----------
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
async function signInReq(w: Who) {
  const message = `Sign in to Yeetpad\naccount: ${w.id}\nissued: ${new Date().toISOString()}`;
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const signed = await new KeyPairSigner(w.kp).signNep413Message(w.id, { message, recipient: VAULT, nonce });
  return { accountId: w.id, publicKey: w.kp.getPublicKey().toString(), signature: b64(signed.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null };
}
async function call(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  return { status: r.status, j };
}
const post = (p: string, b: unknown, t?: string) => call("POST", p, b, t);
const get = (p: string, t?: string) => call("GET", p, undefined, t);
async function session(w: Who) {
  return post("/api/auth/session", await signInReq(w));
}
async function mustSession(w: Who) {
  const r = await session(w);
  assert(r.status === 200 && r.j.token, `sign-in ${w.id}: ${r.status} ${JSON.stringify(r.j)}`);
  return r.j.token as string;
}
const page = async (path: string, ua = BROWSER_UA) => {
  const r = await fetch(`${SITE}${path}`, { redirect: "manual", headers: { "user-agent": ua, "sec-fetch-dest": "document" } });
  return { status: r.status, location: r.headers.get("location"), html: r.status === 200 ? await r.text() : "" };
};
const credit = async (id: string) => BigInt(await view(VAULT, "get_balance", { account_id: id }));
const walletBal = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);
async function topUp(w: Who, need: bigint) {
  const have = await credit(w.id);
  if (have >= need) return null;
  const r = await w.acct.callFunctionRaw({ contractId: VAULT, methodName: "deposit_credits", args: {}, deposit: need - have, gas: 30n * TGAS });
  return r.transaction.hash;
}
const logs = (r: any): string[] => (r.receipts_outcome ?? []).flatMap((o: any) => o.outcome.logs);
const events = (r: any) =>
  logs(r)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)));

const stamp = Date.now().toString(36).slice(-5);
const colors = { primary: "#ff3d8b", secondary: "#2b2bff", accent: "#ffd23f", background: "#fff6e9", text: "#111111" };
const idea = (ticker: string, name: string) => ({
  name,
  ticker,
  tagline: "Yeetpad regression test token",
  description: "Testnet token created by the Yeetpad full regression. Not for trading.",
  colors,
});

console.log(`regression ${stamp}: admin ${admin.id} (wallet ${fmt(await walletBal(admin.id))}, credit ${fmt(await credit(admin.id))}); user ${user.id} (wallet ${fmt(await walletBal(user.id))})`);
const wallet0 = await walletBal(admin.id);

// ---------- 1. landing + waitlist ----------
await check("landing", "/ loads and is the only page with Yeetpad GA G-J9X66TQZKV", async () => {
  const home = await page("/");
  assert(home.status === 200, `/ ${home.status}`);
  assert(home.html.includes("G-J9X66TQZKV"), "GA missing on /");
  const app = await page("/app/");
  assert(app.status === 200 && !app.html.includes("G-J9X66TQZKV"), `/app/ status ${app.status} or has GA`);
  return "/app/ has no GA (token pages checked below)";
});
const wl = Array.from({ length: 11 }, (_, i) => `ypreg${stamp}${i}.testnet`);
await check("waitlist", "signup ok, duplicate is idempotent (already=true)", async () => {
  const a = await post("/api/whitelist", { account: wl[0], contact: null });
  assert(a.status === 200 && a.j.already === false, `first ${a.status} ${JSON.stringify(a.j)}`);
  const b = await post("/api/whitelist", { account: wl[0].toUpperCase(), contact: null });
  assert(b.status === 200 && b.j.already === true, `dup ${b.status} ${JSON.stringify(b.j)}`);
  const bad = await post("/api/whitelist", { account: "not an account" });
  assert(bad.status === 400, `bad input ${bad.status}`);
});
await check("waitlist", "rate limit: 429 after 10 signups/hour from one IP", async () => {
  let n429 = -1;
  for (let i = 1; i < wl.length; i++) {
    const r = await post("/api/whitelist", { account: wl[i], contact: null });
    if (r.status === 429) {
      n429 = i;
      break;
    }
    assert(r.status === 200, `signup ${i} ${r.status}`);
  }
  assert(n429 > 0, "never rate limited");
  return `429 on signup #${n429 + 2} (incl. the duplicate)`;
});

// ---------- 2. auth + gate ----------
let adminTok = "";
await check("auth", "NEP-413 sign-in (admin) and /api/auth/me flags", async () => {
  adminTok = await mustSession(admin);
  const me = await get("/api/auth/me", adminTok);
  assert(me.j.isAdmin === true && me.j.whitelisted === true && me.j.locked === true, JSON.stringify(me.j));
  const bad = await post("/api/auth/session", { ...(await signInReq(admin)), signature: b64(new Uint8Array(64)) });
  assert(bad.status === 401 || bad.status === 400, `bad signature accepted: ${bad.status}`);
  return `me=${JSON.stringify(me.j)}; bad signature -> ${bad.status}`;
});
await check("gate", "admin lists waitlist + allowed; test signups visible", async () => {
  const w = await get("/api/admin/waitlist", adminTok);
  assert(w.status === 200, `waitlist ${w.status}`);
  assert(w.j.entries.some((e: any) => e.account === wl[0]), "test signup not listed");
  const a = await get("/api/admin/allowed", adminTok);
  assert(a.status === 200, `allowed ${a.status}`);
  return `waitlist counts ${JSON.stringify(w.j.counts)}`;
});
await check("gate", "unlisted account gets 403 not_whitelisted", async () => {
  // Make sure the user isn't allowlisted from an earlier run.
  await post("/api/admin/revoke", { accounts: [user.id] }, adminTok);
  const r = await until(async () => {
    const s = await session(user);
    return s.status === 403 ? s : null;
  }, 60_000);
  return `${r.status} ${r.j.code ?? ""}`;
});
let userTok = "";
await check("gate", "approve -> account gets in; /me flags; admin API 403 not_admin", async () => {
  const ap = await post("/api/admin/approve", { accounts: [user.id] }, adminTok);
  assert(ap.status === 200, `approve ${ap.status}`);
  userTok = await until(async () => {
    const s = await session(user);
    return s.status === 200 ? (s.j.token as string) : null;
  }, 60_000);
  const me = await get("/api/auth/me", userTok);
  assert(me.j.isAdmin === false && me.j.whitelisted === true, JSON.stringify(me.j));
  const na = await get("/api/admin/waitlist", userTok);
  assert(na.status === 403 && na.j.code === "not_admin", `non-admin admin call ${na.status} ${JSON.stringify(na.j)}`);
});

// ---------- 3. credits ----------
await check("credits", "deposit_credits to vault, /api/balance reflects it", async () => {
  const before = BigInt((await get(`/api/balance/${admin.id}`)).j.balance);
  const r = await admin.acct.callFunctionRaw({ contractId: VAULT, methodName: "deposit_credits", args: {}, deposit: NEAR / 20n, gas: 30n * TGAS });
  const ev = events(r).find((e) => e.event === "deposit");
  const after = await until(async () => {
    const b = BigInt((await get(`/api/balance/${admin.id}`)).j.balance);
    return b >= before + NEAR / 20n ? b : null;
  }, 30_000);
  return `+0.05 (${fmt(before)} -> ${fmt(after)}), event ${ev ? "deposit" : "none"}: ${TX}${r.transaction.hash}`;
});

// ---------- 4. generate ----------
let genIdeas: any[] = [];
await check("generate", "1 idea", async () => {
  const t0 = Date.now();
  const r = await post("/api/generate", { prompt: "a sleepy owl that runs a midnight bakery", count: 1 }, adminTok);
  assert(r.status === 200 && r.j.ideas?.length === 1, `${r.status} ${JSON.stringify(r.j).slice(0, 200)}`);
  assert(BigInt(r.j.charged) > 0n && r.j.txHash, `not charged: ${r.j.charged}`);
  return `${((Date.now() - t0) / 1000).toFixed(1)}s, "${r.j.idea.name}" $${r.j.idea.ticker}, charged ${fmt(r.j.charged)} (${TX}${r.j.txHash})`;
});
await check("generate", "batch of 5 ideas, unique tickers", async () => {
  const t0 = Date.now();
  const r = await post("/api/generate", { prompt: "retro arcade cats", count: 5 }, adminTok);
  assert(r.status === 200 && r.j.ideas?.length === 5, `${r.status} ${JSON.stringify(r.j).slice(0, 200)}`);
  const t = r.j.ideas.map((i: any) => i.ticker);
  assert(new Set(t).size === 5, `dup tickers ${t}`);
  genIdeas = r.j.ideas;
  return `${((Date.now() - t0) / 1000).toFixed(1)}s, ${t.join(",")}, charged ${fmt(r.j.charged)}`;
});

// ---------- 5. launches ----------
const launched: { ticker: string; tokenId: string; slug: string; venue: string }[] = [];
async function verifyRhea(tokenId: string, listing: any) {
  assert(listing?.ok, `listing not ok: ${JSON.stringify(listing)}`);
  const p = await view(DCL, "get_pool", { pool_id: listing.poolId });
  assert(p && BigInt(p.total_x ?? 0) + BigInt(p.total_y ?? 0) > 0n, `pool empty ${JSON.stringify(p)?.slice(0, 200)}`);
  const lp = await view(DCL, "get_liquidity", { lpt_id: listing.lptId });
  assert(lp?.owner_id === admin.id, `LP owner ${lp?.owner_id}`);
  const q = await view(DCL, "quote", { pool_ids: [listing.poolId], input_token: WNEAR, output_token: tokenId, input_amount: (NEAR / 100n).toString(), tag: null });
  assert(BigInt(q.amount) > 0n, `quote ${JSON.stringify(q)}`);
  const vaultLeft = BigInt(await view(tokenId, "ft_balance_of", { account_id: VAULT }));
  assert(vaultLeft === 0n, `vault still holds ${vaultLeft}`);
  return `pool ${listing.poolId} LP ${listing.lptId} owned by creator; 0.01 wNEAR -> ${(Number(BigInt(q.amount)) / 1e18).toFixed(0)} tokens; tx ${TX}${listing.txHash}`;
}
if (args.has("--skip-launch")) skip("launch", "all launch checks", "--skip-launch");
else {
  // Pre-flight failure paths (no spend): taken ticker 409, no credit 402.
  await check("launch", "failure paths: taken ticker 409, insufficient credit 402 (nothing charged)", async () => {
    const mine = (await get(`/api/launches/${admin.id}`)).j.launches;
    const taken = mine.find((l: any) => (l.venue ?? "yeetpad") !== "nearly")?.ticker;
    const a = await post("/api/launch", { idea: idea(taken, "Taken Name") }, adminTok);
    assert(a.status === 409, `taken ${a.status}`);
    const uc = await credit(user.id);
    const b = await post("/api/launch", { idea: idea(`yq${stamp}`, `Broke ${stamp}`) }, userTok);
    assert(b.status === 402, `no credit ${b.status} ${JSON.stringify(b.j)}`);
    assert((await credit(user.id)) === uc, "user charged");
    return `409 for "${taken}", 402 for empty credit`;
  });

  await check("launch", "single, List on = None", async () => {
    await topUp(admin, 2n * NEAR);
    const c0 = await credit(admin.id);
    const g = genIdeas[0] ?? idea(`yn${stamp}`, `Yeet None ${stamp}`);
    const i = { ...g, ticker: `yn${stamp}` };
    const r = await post("/api/launch", { idea: i, listOn: "none" }, adminTok);
    assert(r.status === 200 && r.j.tokenId, `${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
    const meta = await view(r.j.tokenId, "ft_metadata");
    const bal = await view(r.j.tokenId, "ft_balance_of", { account_id: admin.id });
    assert(BigInt(bal) === BigInt(await view(r.j.tokenId, "ft_total_supply")), "creator doesn't hold full supply");
    launched.push({ ticker: i.ticker, tokenId: r.j.tokenId, slug: r.j.siteConfig.slug, venue: "yeetpad" });
    return `${r.j.tokenId} (${meta.symbol}), creator holds supply, cost ${fmt(c0 - (await credit(admin.id)))}; ${r.j.explorerUrl}`;
  });

  await check("launch", "single, List on = Rhea (pool, LP to creator, quote)", async () => {
    const q = await post("/api/quote", { ideas: [idea(`yr${stamp}`, `Yeet Rhea ${stamp}`)], listOn: "rhea" }, adminTok);
    assert(q.status === 200, `quote ${q.status} ${JSON.stringify(q.j).slice(0, 200)}`);
    await topUp(admin, BigInt(q.j.total) + NEAR / 50n);
    const c0 = await credit(admin.id);
    const g = genIdeas[1] ?? idea("x", `Yeet Rhea ${stamp}`);
    const i = { ...g, ticker: `yr${stamp}` };
    const r = await post("/api/launch", { idea: i, listOn: "rhea" }, adminTok);
    assert(r.status === 200 && r.j.tokenId, `${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
    const v = await verifyRhea(r.j.tokenId, r.j.listing);
    launched.push({ ticker: i.ticker, tokenId: r.j.tokenId, slug: r.j.siteConfig.slug, venue: "rhea" });
    return `quoted ${fmt(q.j.total)}, spent ${fmt(c0 - (await credit(admin.id)))}; ${v}`;
  });

  await check("launch", "batch of 3, List on = Rhea", async () => {
    const ideas = [0, 1, 2].map((k) => ({ ...(genIdeas[2 + k] ?? idea("x", `Batch ${k}`)), ticker: `${["a", "m", "z"][k]}b${stamp}` }));
    const q = await post("/api/quote", { ideas, listOn: "rhea" }, adminTok);
    await topUp(admin, BigInt(q.j.total) + NEAR / 50n);
    const c0 = await credit(admin.id);
    const t0 = Date.now();
    const r = await post("/api/launch/batch", { ideas, listOn: "rhea" }, adminTok);
    assert(r.status === 200, `${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
    const notes: string[] = [];
    for (const it of r.j.results) {
      assert(it.ok, `${it.ticker}: ${it.error}`);
      notes.push(`${it.ticker}: ${await verifyRhea(it.tokenId, it.listing)}`);
      launched.push({ ticker: it.ticker, tokenId: it.tokenId, slug: it.slug, venue: "rhea" });
    }
    return `${((Date.now() - t0) / 1000).toFixed(0)}s, quoted ${fmt(q.j.total)}, spent ${fmt(c0 - (await credit(admin.id)))}; launch ${r.j.explorerUrl}; ${notes.join(" | ")}`;
  });

  await check("relist", "re-list the None token on Rhea (Studio button flow: storage_deposit + ft_transfer_call, then /api/list/rhea)", async () => {
    const t = launched.find((l) => l.venue === "yeetpad");
    assert(t, "no None token");
    await topUp(admin, (await credit(admin.id)) + 25n * 10n ** 21n);
    const bal = await view(t.tokenId, "ft_balance_of", { account_id: admin.id });
    const tx: any = await admin.acct.signAndSendTransaction({
      receiverId: t.tokenId,
      actions: [
        A.functionCall("storage_deposit", { account_id: VAULT, registration_only: true }, 10n * TGAS, 1_250_000_000_000_000_000_000n),
        A.functionCall("ft_transfer_call", { receiver_id: VAULT, amount: bal, msg: "list_on_rhea" }, 60n * TGAS, 1n),
      ],
    });
    const r = await post("/api/list/rhea", { tokenId: t.tokenId }, adminTok);
    assert(r.status === 200, `${r.status} ${JSON.stringify(r.j).slice(0, 300)}`);
    const v = await verifyRhea(t.tokenId, r.j.listing);
    t.venue = "rhea";
    return `send ${TX}${tx.transaction.hash}; ${v}`;
  });
}

// ---------- 6. token sites ----------
const site = launched[0] ?? (await (async () => {
  const l = (await get(`/api/launches/${admin.id}`)).j.launches.find((x: any) => x.slug && x.venue !== "nearly");
  return l ? { ticker: l.ticker, tokenId: l.tokenId, slug: l.slug, venue: l.venue } : null;
})());
if (!site) skip("site", "token site checks", "no launched token");
else {
  await check("site", "slug URL 200 with server-side meta, no Yeetpad navbar/GA, disclosure footer", async () => {
    const p = await page(`/t/${site.slug}`);
    assert(p.status === 200, `status ${p.status}`);
    const s = (await get(`/api/site/${site.slug}`)).j.siteConfig;
    const title = /<meta property="og:title" content="([^"]*)"/.exec(p.html)?.[1] ?? "";
    assert(title.includes(s.branding.name.replace(/&/g, "&amp;")) || title.includes(s.branding.name), `og:title "${title}"`);
    assert(/<meta name="description" content="[^"]{10,}"/.test(p.html), "no description meta");
    assert(!p.html.includes('class="site-header"'), "Yeetpad navbar present");
    assert(!p.html.includes("G-J9X66TQZKV"), "Yeetpad GA on token page");
    assert(/Launched with Yeetpad/.test(p.html) && /zero real value/.test(p.html), "disclosure footer missing");
    return `og:title "${title}"`;
  });
  await check("site", "ticker URL 301 -> slug URL", async () => {
    if (site.slug === site.ticker) return "slug equals ticker (no redirect needed)";
    const p = await page(`/t/${site.ticker}`);
    assert(p.status === 301 && p.location?.endsWith(`/t/${site.slug}`), `${p.status} ${p.location}`);
    return `${p.status} -> ${p.location}`;
  });
  await check("site", "view counter increments for a browser view, not for a bot", async () => {
    const v0 = Number((await get(`/api/site/${site.slug}`)).j.views ?? 0);
    await page(`/t/${site.slug}`, "curl/8.0");
    await page(`/t/${site.slug}`);
    const v1 = await until(async () => {
      const v = Number((await get(`/api/site/${site.slug}`)).j.views ?? 0);
      return v > v0 ? v : null;
    }, 90_000, 5000);
    return `${v0} -> ${v1}`;
  });
  await check("site", "creator GA set/clear; non-owner 403", async () => {
    const ga = "G-REGTEST01";
    const s1 = await call("PUT", `/api/site/${site.slug}/settings`, { gaId: ga }, adminTok);
    assert(s1.status === 200, `set ${s1.status} ${JSON.stringify(s1.j)}`);
    await until(async () => (await page(`/t/${site.slug}`, "curl/8.0")).html.includes(`gtag/js?id=${ga}`), 90_000, 5000);
    const no = await call("PUT", `/api/site/${site.slug}/settings`, { gaId: "G-HIJACK123" }, userTok);
    assert(no.status === 403, `non-owner ${no.status}`);
    const bad = await call("PUT", `/api/site/${site.slug}/settings`, { gaId: "<script>" }, adminTok);
    assert(bad.status === 400, `bad id ${bad.status}`);
    const s2 = await call("PUT", `/api/site/${site.slug}/settings`, { gaId: null }, adminTok);
    assert(s2.status === 200 && s2.j.gaId === null, `clear ${s2.status}`);
    await until(async () => {
      const h = (await page(`/t/${site.slug}`, "curl/8.0")).html;
      return h.length > 0 && !h.includes(ga);
    }, 90_000, 5000);
    return "set -> served in <head>; non-owner 403; invalid 400; cleared";
  });
}

// ---------- 7. My launches + venues ----------
await check("my launches", "lists every token from this run with venue links + views", async () => {
  const l = (await get(`/api/launches/${admin.id}?limit=50`)).j.launches as any[];
  for (const t of launched) {
    const x = l.find((y) => y.tokenId === t.tokenId);
    assert(x, `missing ${t.tokenId}`);
    assert(x.venue === t.venue, `${t.ticker} venue ${x.venue} != ${t.venue}`);
    if (t.venue === "rhea") assert(x.venueUrl?.includes("poolV2"), `${t.ticker} venueUrl ${x.venueUrl}`);
    assert(typeof x.views === "number" && x.siteUrl, `${t.ticker} views/siteUrl`);
  }
  return `${l.length} launches; this run: ${launched.map((t) => `${t.ticker}:${t.venue}`).join(", ")}`;
});
await check("venues", "health: Nearly + JustHoot off with reasons; Studio bundle shows them", async () => {
  const h = (await get("/api/health")).j;
  assert(h.ok && h.venues.nearly.enabled === false && h.venues.nearly.reason, `nearly ${JSON.stringify(h.venues.nearly)}`);
  assert(h.venues.justhoot.enabled === false && h.venues.justhoot.reason === "mainnet only, enabled at mainnet launch", `justhoot ${JSON.stringify(h.venues.justhoot)}`);
  const app = (await page("/app/")).html;
  const js = /\/_astro\/Studio\.[A-Za-z0-9_-]+\.js/.exec(app)?.[0];
  assert(js, "Studio chunk not found");
  const code = await (await fetch(`${SITE}${js}`)).text();
  assert(code.includes("on JustHoot") && code.includes("Nearly: ") && code.includes("JustHoot: "), "venue UI missing from bundle");
  const q = await post("/api/quote", { ideas: [idea(`yj${stamp}`, `Yeet Hoot ${stamp}`)], listOn: "justhoot" }, adminTok);
  const n = await post("/api/nearly/prepare", { ideas: [idea(`yk${stamp}`, `Yeet Nearly ${stamp}`)] }, adminTok);
  assert(q.status === 503 && n.status === 503, `quote justhoot ${q.status}, nearly prepare ${n.status}`);
  return `nearly: "${h.venues.nearly.reason.slice(0, 60)}…"; justhoot: "${h.venues.justhoot.reason}"; API 503 venue_disabled`;
});

// ---------- 8. contract admin (owner = user key) ----------
if (args.has("--skip-admin-contract")) skip("contracts", "admin functions", "--skip-admin-contract");
else {
  for (const c of [VAULT, FACTORY]) {
    await check("contracts", `${c.split(".")[0]}: set_paused true/false by owner, events, blocks while paused, non-owner rejected`, async () => {
      const p1: any = await user.acct.callFunctionRaw({ contractId: c, methodName: "set_paused", args: { paused: true }, gas: 30n * TGAS });
      const cfg = c === VAULT ? await view(c, "get_config") : await view(c, "get_config");
      let blocked = "";
      try {
        if (c === VAULT) await admin.acct.callFunctionRaw({ contractId: VAULT, methodName: "deposit_credits", args: {}, deposit: NEAR / 1000n, gas: 30n * TGAS });
        else
          await admin.acct.callFunctionRaw({
            contractId: FACTORY,
            methodName: "create_token",
            args: { ticker: `yp${stamp}`, metadata: { spec: "ft-1.0.0", name: "Paused", symbol: "P", icon: null, reference: null, reference_hash: null, decimals: 18 }, total_supply: "1000", owner_id: admin.id, site: null, mint_to: null },
            deposit: NEAR / 1000n,
            gas: 100n * TGAS,
          });
        blocked = "NOT blocked";
      } catch (e) {
        blocked = /paused/i.test(String((e as Error).message)) ? "blocked (paused)" : `failed: ${String((e as Error).message).slice(0, 80)}`;
      }
      const p0: any = await user.acct.callFunctionRaw({ contractId: c, methodName: "set_paused", args: { paused: false }, gas: 30n * TGAS });
      let nonOwner = "";
      try {
        await admin.acct.callFunctionRaw({ contractId: c, methodName: "set_paused", args: { paused: true }, gas: 30n * TGAS });
        nonOwner = "ACCEPTED";
      } catch {
        nonOwner = "rejected";
      }
      const after = await view(c, "get_config");
      const e1 = events(p1).map((e) => e.event);
      const e0 = events(p0).map((e) => e.event);
      assert(cfg.paused === true && after.paused === false, `paused flags ${cfg.paused}/${after.paused}`);
      assert(e1.includes("paused") && e0.includes("unpaused"), `events ${e1}/${e0}`);
      assert(blocked === "blocked (paused)", blocked);
      assert(nonOwner === "rejected", `non-owner set_paused ${nonOwner}`);
      return `pause ${TX}${p1.transaction.hash} unpause ${TX}${p0.transaction.hash}; ${blocked}; non-owner ${nonOwner}`;
    });
  }
  for (const [c, name] of [[VAULT, "near_launch_vault"], [FACTORY, "near_ft_factory"]] as const) {
    await check("contracts", `${c.split(".")[0]}: upgrade path update_contract(same wasm) + migrate keeps state`, async () => {
      const code = new Uint8Array(readFileSync(resolve(import.meta.dir, "../contracts/res", `${name}.wasm`)));
      const before = await view(c, "get_config");
      const bal = c === VAULT ? await credit(admin.id) : BigInt(await view(c, "get_tokens_created"));
      const h0 = (await provider.viewAccount({ accountId: c })).code_hash;
      const r: any = await user.acct.signAndSendTransaction({ receiverId: c, actions: [A.functionCall("update_contract", code, 250n * TGAS, 0n)] });
      const failed = JSON.stringify(r.status ?? {}).includes("Failure") || (r.receipts_outcome ?? []).some((o: any) => o.outcome.status?.Failure);
      if (failed) throw new Error(`update_contract failed: ${String(JSON.stringify(r.receipts_outcome?.find((o: any) => o.outcome.status?.Failure)?.outcome.status ?? r.status)).slice(0, 200)}`);
      const after = await view(c, "get_config");
      const bal2 = c === VAULT ? await credit(admin.id) : BigInt(await view(c, "get_tokens_created"));
      const h1 = (await provider.viewAccount({ accountId: c })).code_hash;
      assert(JSON.stringify(after) === JSON.stringify(before) && bal2 === bal && h1 === h0, `state/code changed: ${JSON.stringify(after)} ${bal2} ${h1}`);
      return `${TX}${r.transaction.hash}; config + ${c === VAULT ? "credit" : "tokens_created"} unchanged, version ${after.version}`;
    });
  }
}

// ---------- 9. gate revoke + cleanup ----------
await check("gate", "revoke kicks the existing session (403 on a gated route)", async () => {
  const rv = await post("/api/admin/revoke", { accounts: [user.id] }, adminTok);
  assert(rv.status === 200, `revoke ${rv.status}`);
  const r = await until(async () => {
    const x = await post("/api/launch", {}, userTok); // gated before body validation
    return x.status === 403 ? x : null;
  }, 90_000, 5000);
  const s = await session(user);
  assert(s.status === 403, `new sign-in after revoke ${s.status}`);
  return `old session -> ${r.status} ${r.j.code ?? ""}; new sign-in ${s.status}`;
});
await check("cleanup", "remove test waitlist/allow entries", async () => {
  const r = await post("/api/admin/remove", { accounts: [...wl, user.id] }, adminTok);
  assert(r.status === 200, `remove ${r.status}`);
  const w = (await get("/api/admin/waitlist", adminTok)).j;
  const left = w.entries.filter((e: any) => e.account.startsWith(`ypreg${stamp}`) || e.account === user.id);
  return `removed ${wl.length + 1}; still listed (KV list lag ok): ${left.length}`;
});

console.log(`\nwallet spent ${fmt(wallet0 - (await walletBal(admin.id)))} NEAR; credit now ${fmt(await credit(admin.id))}`);
console.log("\n| area | check | result | note |\n|---|---|---|---|");
for (const r of results) console.log(`| ${r.area} | ${r.check} | ${r.ok === null ? "SKIP" : r.ok ? "PASS" : "FAIL"} | ${r.note.replace(/\|/g, "/")} |`);
process.exit(results.some((r) => r.ok === false) ? 1 : 0);

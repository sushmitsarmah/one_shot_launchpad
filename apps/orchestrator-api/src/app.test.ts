import { beforeAll, describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { LaunchIdea, LaunchResponse } from "@osl/schema";
import { signIn } from "./test-helpers";

let app: typeof import("./app").app;
const RECIPIENT = "launch-vault.mock.testnet";
beforeAll(async () => {
  process.env.LLM_MOCK = "1";
  process.env.NEAR_MOCK = "1";
  process.env.SESSION_SECRET = "test-secret";
  process.env.VAULT_CONTRACT = RECIPIENT;
  process.env.LOCKED = "0";
  process.env.ADMIN_ACCOUNTS = "boss.testnet"; // these tests exercise the open app; the gate has its own tests (gate.test.ts)
  ({ app } = await import("./app"));
  (await import("./config")).configureFromEnv({});
});

const tokens = new Map<string, string>();
async function session(account: string) {
  if (!tokens.has(account)) {
    const req = await signIn(KeyPair.fromRandom("ed25519"), account, RECIPIENT);
    const r = await app.request("/api/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    expect(r.status).toBe(200);
    tokens.set(account, (await r.json()).token);
  }
  return tokens.get(account)!;
}

// Signs in as body.ownerWallet (if any) unless an explicit token/null is given.
const post = async (path: string, body: any, token?: string | null) => {
  const t = token === undefined ? (body?.ownerWallet && /^[a-z0-9._-]+$/.test(body.ownerWallet) ? await session(body.ownerWallet) : null) : token;
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(body),
  });
};

describe("api (mock mode)", () => {
  test("generate returns a valid idea", async () => {
    const r = await post("/api/generate", { prompt: "a token for cat lovers", ownerWallet: "alice.testnet" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(LaunchIdea.safeParse(j.idea).success).toBe(true);
  });

  test("generate rejects bad input", async () => {
    const r = await post("/api/generate", { prompt: "" }, await session("alice.testnet"));
    expect(r.status).toBe(400);
  });

  test("launch returns token + site config", async () => {
    const g = await (await post("/api/generate", { prompt: "rocket dogs", ownerWallet: "bob.testnet" })).json();
    const r = await post("/api/launch", { ownerWallet: "bob.testnet", idea: g.idea });
    expect(r.status).toBe(200);
    const j = LaunchResponse.parse(await r.json());
    expect(j.tokenId.startsWith(g.idea.ticker + ".")).toBe(true);
  });

  test("generate without a session is 401", async () => {
    expect((await post("/api/generate", { prompt: "no auth here" }, null)).status).toBe(401);
    expect((await post("/api/generate", { prompt: "bad auth here" }, "garbage.token")).status).toBe(401);
    expect((await post("/api/launch", { idea: {} }, null)).status).toBe(401);
  });

  test("ownerWallet must match the session account", async () => {
    const r = await post("/api/generate", { prompt: "impersonation", ownerWallet: "bob.testnet" }, await session("alice.testnet"));
    expect(r.status).toBe(403);
  });

  test("account comes from the session when ownerWallet is omitted", async () => {
    const r = await post("/api/generate", { prompt: "a token for cat lovers" }, await session("frank.testnet"));
    expect(r.status).toBe(200);
  });

  test("auth/session rejects a bad signature", async () => {
    const req = await signIn(KeyPair.fromRandom("ed25519"), "dave.testnet", RECIPIENT);
    const r = await app.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...req, accountId: "erin.testnet" }),
    });
    expect(r.status).toBe(401);
  });

  test("balance", async () => {
    const r = await app.request("/api/balance/carol.testnet");
    expect((await r.json()).balance).toBe((10n * 10n ** 24n).toString());
  });
});

describe("llm parsing", () => {
  test("parses fenced json and normalizes ticker", async () => {
    const { parseIdeaText } = await import("./llm");
    const idea = parseIdeaText(
      '```json\n{"name":"Moon Cat","ticker":"MOON-CAT","tagline":"meow to the moon","description":"A very good cat token.","colors":{"primary":"#112233","secondary":"#445566","accent":"#778899","background":"#000000","text":"#ffffff"}}\n```',
    );
    expect(idea.ticker).toBe("mooncat");
  });
});

describe("batch + sites (mock mode)", () => {
  const idea = (ticker: string) => ({
    name: `${ticker} coin`,
    ticker,
    tagline: "to the moon and back",
    description: "A test token for the batch launch endpoint.",
    colors: { primary: "#ff4fa3", secondary: "#4cc9f0", accent: "#c6f432", background: "#1b1433", text: "#fff3dc" },
  });

  test("generate count=3 returns 3 distinct ideas and charges 3x", async () => {
    const t = await session("gina.testnet");
    const before = BigInt((await (await app.request("/api/balance/gina.testnet")).json()).balance);
    const r = await post("/api/generate", { prompt: "cats in space", count: 3 }, t);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ideas.length).toBe(3);
    expect(new Set(j.ideas.map((i: { ticker: string }) => i.ticker)).size).toBe(3);
    const after = BigInt((await (await app.request("/api/balance/gina.testnet")).json()).balance);
    expect(before - after).toBe(3n * 10n ** 22n);
    expect((await post("/api/generate", { prompt: "too many", count: 6 }, t)).status).toBe(400);
  });

  test("a 12-idea run in MAX_BATCH chunks: avoid list keeps tickers unique, each chunk charged", async () => {
    const { chunkSizes, MAX_BATCH } = await import("@osl/schema");
    const t = await session("ivy.testnet");
    const before = BigInt((await (await app.request("/api/balance/ivy.testnet")).json()).balance);
    const seen = { tickers: new Set<string>() };
    const all: { ticker: string }[] = [];
    for (const n of chunkSizes(12)) {
      expect(n).toBeLessThanOrEqual(MAX_BATCH);
      const r = await post("/api/generate", { prompt: "cats in space", count: n, avoid: [...seen.tickers] }, t);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.ideas.length).toBe(n);
      for (const i of j.ideas) expect(seen.tickers.has(i.ticker)).toBe(false);
      for (const i of j.ideas) seen.tickers.add(i.ticker);
      all.push(...j.ideas);
    }
    expect(new Set(all.map((i) => i.ticker)).size).toBe(12);
    const after = BigInt((await (await app.request("/api/balance/ivy.testnet")).json()).balance);
    expect(before - after).toBe(12n * 10n ** 22n);
  });

  test("generate takes a run position (seq) for per-idea angles; out-of-range seq is rejected", async () => {
    const t = await session("jade.testnet");
    const r = await post("/api/generate", { prompt: "sleepy owls", count: 2, seq: 95 }, t);
    expect(r.status).toBe(200);
    expect((await r.json()).ideas.length).toBe(2);
    expect((await post("/api/generate", { prompt: "sleepy owls", count: 1, seq: 10_000 }, t)).status).toBe(400);
  });

  test("launch uses the creator's edited idea: name/symbol, slug from the edited name, description; bad edits are 400", async () => {
    const t = await session("kim.testnet");
    const edited = { ...idea("edtk"), name: "  My Edited Name  ", tagline: "edited tagline here", description: "Edited description that is long enough." };
    const r = await post("/api/launch/batch", { ideas: [edited] }, t);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.results[0].slug).toBe("my-edited-name");
    const s = await (await app.request("/api/site/my-edited-name")).json();
    expect(s.siteConfig.branding.name).toBe("My Edited Name");
    expect(s.siteConfig.branding.ticker).toBe("EDTK");
    expect(s.siteConfig.branding.description).toBe("Edited description that is long enough.");
    expect(s.siteConfig.branding.tagline).toBe("edited tagline here");
    for (const bad of [{ ...idea("edbad"), name: "   " }, { ...idea("edbad"), ticker: "EdBad" }, { ...idea("edbad"), description: "x".repeat(601) }, { ...idea("9bad") }]) {
      expect((await post("/api/launch/batch", { ideas: [bad] }, t)).status).toBe(400);
    }
  });

  test("take down / restore: creator-only, admin can moderate, 410, hidden from launches", async () => {
    const owner = await session("lena.testnet");
    const other = await session("mo.testnet");
    const boss = await session("boss.testnet");
    const r = await post("/api/launch/batch", { ideas: [idea("deltk"), idea("deltwo")] }, owner);
    expect(r.status).toBe(200);
    const slug = (await r.json()).results[0].slug;
    const launches = async (q = "") => (await (await app.request(`/api/launches/lena.testnet${q}`)).json()).launches as { ticker: string; deletedAt?: number }[];
    expect((await launches()).map((l) => l.ticker)).toContain("deltk");

    // non-owner: 403, nothing changes
    const bad = await post("/api/tokens/delete", { tokens: ["deltk"] }, other);
    expect(bad.status).toBe(403);
    expect((await app.request(`/api/site/${slug}`)).status).toBe(200);
    expect((await post("/api/tokens/delete", { tokens: ["deltk"] }, null)).status).toBe(401);
    expect((await post("/api/tokens/delete", { tokens: ["Bad!"] }, owner)).status).toBe(400);
    expect((await post("/api/tokens/delete", { tokens: Array.from({ length: 51 }, (_, i) => `tk${i}x`) }, owner)).status).toBe(400);

    // owner: soft delete
    const d = await post("/api/tokens/delete", { tokens: ["deltk"] }, owner);
    expect(d.status).toBe(200);
    expect((await d.json()).results[0]).toEqual({ ticker: "deltk", ok: true });
    const gone = await app.request(`/api/site/${slug}`);
    expect(gone.status).toBe(410);
    expect((await gone.json()).code).toBe("taken_down");
    expect((await app.request("/api/site/deltk")).status).toBe(410);
    expect((await launches()).map((l) => l.ticker)).not.toContain("deltk");
    const all = await launches("?includeDeleted=1");
    expect(all.find((l) => l.ticker === "deltk")?.deletedAt).toBeGreaterThan(0);
    expect(all.find((l) => l.ticker === "deltwo")?.deletedAt ?? null).toBeNull();
    // data kept
    const { findSite } = await import("./sites");
    expect((await findSite("deltk"))?.site.takenDown?.by).toBe("lena.testnet");
    expect((await findSite("deltk"))?.site.branding.name).toBeDefined();

    // restore: non-owner 403, owner ok
    expect((await post("/api/tokens/restore", { tokens: ["deltk"] }, other)).status).toBe(403);
    expect((await post("/api/tokens/restore", { tokens: ["deltk"] }, owner)).status).toBe(200);
    expect((await app.request(`/api/site/${slug}`)).status).toBe(200);
    expect((await findSite("deltk"))?.site.takenDown).toBeUndefined();
    expect((await launches()).map((l) => l.ticker)).toContain("deltk");

    // admin can take down anyone's token; then the creator can't restore it, the admin can
    expect((await post("/api/tokens/delete", { tokens: ["deltwo"] }, boss)).status).toBe(200);
    expect((await app.request("/api/site/deltwo")).status).toBe(410);
    const cr = await post("/api/tokens/restore", { tokens: ["deltwo"] }, owner);
    expect(cr.status).toBe(403);
    expect((await cr.json()).results[0].note).toContain("moderator");
    expect((await post("/api/tokens/restore", { tokens: ["deltwo"] }, boss)).status).toBe(200);
    expect((await app.request("/api/site/deltwo")).status).toBe(200);

    // unknown ticker: 404 for a creator
    expect((await post("/api/tokens/delete", { tokens: ["nosuchtk"] }, owner)).status).toBe(404);
  });

  test("NEAR Intents: bulk toggle is creator-only/admin; page config; always mainnet 1Click; tips need a mainnet recipient, buy as configured", async () => {
    const owner = await session("iris.testnet");
    const other = await session("mo.testnet");
    const boss = await session("boss.testnet");
    const r = await post("/api/launch/batch", { ideas: [idea("intone"), idea("inttwo")] }, owner);
    expect(r.status).toBe(200);
    const slug = (await r.json()).results[0].slug;
    // off by default
    const s0 = await (await app.request(`/api/site/${slug}`)).json();
    expect(s0.intents).toBeNull();
    expect(s0.siteConfig.intents).toBeUndefined();
    expect(s0.network).toBe("testnet");

    const on = { enabled: true, mode: "both" };
    expect((await post("/api/tokens/intents", { tokens: ["intone"], intents: on }, other)).status).toBe(403);
    expect((await post("/api/tokens/intents", { tokens: ["intone"], intents: on }, null)).status).toBe(401);
    expect((await post("/api/tokens/intents", { tokens: ["intone"], intents: { enabled: true, mode: "swap" } }, owner)).status).toBe(400);
    expect((await post("/api/tokens/intents", { tokens: Array.from({ length: 51 }, (_, i) => `tk${i}x`), intents: on }, owner)).status).toBe(400);
    const mixed = await post("/api/tokens/intents", { tokens: ["intone", "inttwo", "nosuchtk"], intents: on }, owner);
    expect(mixed.status).toBe(200);
    expect((await mixed.json()).results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, false]);
    // testnet deployment, creator is a .testnet account, no mainnet recipient: buy only (tips hidden)
    const s1 = await (await app.request(`/api/site/${slug}`)).json();
    expect(s1.intents).toEqual({ enabled: true, mode: "buy", tipAsset: "usdc" });
    type L = { ticker: string; intents?: { enabled: boolean }; intentsState?: { tip: boolean; buy: boolean; recipient: string | null; notes: string[] } };
    const mine = async () => (await (await app.request("/api/launches/iris.testnet")).json()).launches as L[];
    const st0 = (await mine()).find((l) => l.ticker === "intone");
    expect(st0?.intents?.enabled).toBe(true);
    expect(st0?.intentsState).toMatchObject({ tip: false, buy: true, recipient: null });
    expect(st0?.intentsState?.notes.length).toBe(1);
    // a .testnet name is never accepted as a tip recipient
    expect((await post("/api/tokens/intents", { tokens: ["intone"], intents: { ...on, recipient: "iris.testnet" } }, owner)).status).toBe(400);
    // the creator's default mainnet payout account
    const put = (b: object, t: string | null) => app.request("/api/intents/payout", { method: "PUT", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) });
    expect((await put({ account: "iris.near" }, null)).status).toBe(401);
    expect((await put({ account: "iris.testnet" }, owner)).status).toBe(400);
    expect((await put({ account: "iris.near", extra: 1 }, owner)).status).toBe(400);
    const saved = await put({ account: " Iris.near " }, owner);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ payout: "iris.near", tipRecipient: "iris.near", network: "testnet" });
    expect(await (await app.request("/api/intents/settings", { headers: { authorization: `Bearer ${owner}` } })).json()).toMatchObject({ payout: "iris.near" });
    const s2 = await (await app.request(`/api/site/${slug}`)).json();
    expect(s2.intents).toEqual({ enabled: true, mode: "both", tipAsset: "usdc", recipient: "iris.near" });
    expect(s2.siteConfig.intents.mode).toBe("both");
    expect((await mine()).find((l) => l.ticker === "intone")?.intentsState).toMatchObject({ tip: true, buy: true, recipient: "iris.near", notes: [] });
    // admin may change it; disable again
    expect((await post("/api/tokens/intents", { tokens: ["inttwo"], intents: { enabled: false, mode: "both" } }, boss)).status).toBe(200);
    expect((await (await app.request("/api/site/inttwo")).json()).intents).toBeNull();

    // quote proxy (1Click mocked)
    const { resetTokenCache } = await import("./intents");
    resetTokenCache();
    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u);
      if (url.endsWith("/v0/tokens")) return new Response(JSON.stringify([{ assetId: "nep141:sol.omft.near", symbol: "SOL", blockchain: "sol", decimals: 9, price: 100 }]));
      if (url.endsWith("/v0/quote")) {
        const b = JSON.parse(init.body);
        sent.push(b);
        return new Response(JSON.stringify({ quote: { amountIn: b.amount, amountInFormatted: "0.1", amountOut: "2", amountOutFormatted: "2", minAmountOut: "1", timeEstimate: 20, depositAddress: "SHOULD-NOT-LEAK-ON-DRY" }, quoteRequest: b, signature: "ed25519:x", correlationId: "c" }));
      }
      return realFetch(u, init);
    }) as typeof fetch;
    try {
      const q = (b: object) => post("/api/intents/quote", { site: slug, originAsset: "nep141:sol.omft.near", amount: "100000000", ...b }, null);
      const tip = await q({ mode: "tip", refundTo: "So1Refund11111111111111111111111111111111", dry: false });
      expect(tip.status).toBe(200);
      const tj = await tip.json();
      expect(tj.preview).toBe(false); // a real mainnet quote even on a testnet deployment
      expect(tj.dry).toBe(false);
      expect(tj.depositAddress).toBe("SHOULD-NOT-LEAK-ON-DRY");
      expect(sent.at(-1).dry).toBe(false);
      expect(sent.at(-1).recipient).toBe("iris.near");
      expect(sent.at(-1).appFees).toBeUndefined();
      expect(sent.at(-1).destinationAsset).toBe("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
      const dryTip = await (await q({ mode: "tip", dry: true })).json();
      expect(dryTip.depositAddress).toBeNull();
      expect(sent.at(-1).dry).toBe(true);
      // buy: same mainnet quote on a testnet deployment (no special gating), wNEAR to the visitor
      const buy = await (await q({ mode: "buy", dry: true })).json();
      expect(buy.destinationAsset).toBe("nep141:wrap.near");
      expect(sent.at(-1).recipient).toBe("intents.near");
      expect((await q({ mode: "buy", recipient: "someone.testnet", refundTo: "x12" })).status).toBe(400);
      // clearing the payout hides tips again
      expect((await put({ account: null }, owner)).status).toBe(200);
      expect((await q({ mode: "tip", dry: true })).status).toBe(409);
      expect((await (await app.request(`/api/site/${slug}`)).json()).intents).toEqual({ enabled: true, mode: "buy", tipAsset: "usdc" });
      // a per-page mainnet recipient works too
      expect((await post("/api/tokens/intents", { tokens: ["intone"], intents: { ...on, recipient: "page.near" } }, owner)).status).toBe(200);
      await q({ mode: "tip", dry: true });
      expect(sent.at(-1).recipient).toBe("page.near");
      expect((await q({ mode: "tip", originAsset: "nep141:not-listed.near" })).status).toBe(400);
      expect((await q({ mode: "tip", amount: "0" })).status).toBe(400);
      expect((await post("/api/intents/quote", { site: "inttwo", mode: "tip", originAsset: "nep141:sol.omft.near", amount: "1" }, null)).status).toBe(403);
      await post("/api/tokens/intents", { tokens: ["intone"], intents: { enabled: true, mode: "tip" } }, owner);
      expect((await q({ mode: "buy" })).status).toBe(403);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect((await app.request("/api/intents/status?depositAddress=bad addr")).status).toBe(400);
  });

  test("health reports the per-call chunk and the run size", async () => {
    const h = await (await app.request("/api/health")).json();
    expect(h.maxBatch).toBe(5);
    expect(h.maxRun).toBe(100);
  });

  test("batch launch, site pages and my launches", async () => {
    const t = await session("hank.testnet");
    const r = await post("/api/launch/batch", { ideas: [idea("alpha"), idea("beta")] }, t);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true]);
    expect(j.results[0].siteUrl).toBe("https://yeetpad.fun/t/alpha-coin");

    const s = await (await app.request("/api/site/beta")).json();
    expect(s.siteConfig.branding.ticker).toBe("BETA");
    expect(s.siteConfig.iconDataUri.startsWith("data:image/svg+xml,")).toBe(true);

    const mine = await (await app.request("/api/launches/hank.testnet")).json();
    expect(mine.launches.map((l: { ticker: string }) => l.ticker)).toEqual(["beta", "alpha"]);

    // taken + duplicate + oversize
    expect((await post("/api/launch/batch", { ideas: [idea("alpha")] }, t)).status).toBe(409);
    expect((await post("/api/launch/batch", { ideas: [idea("gamma"), idea("gamma")] }, t)).status).toBe(400);
    expect((await post("/api/launch/batch", { ideas: ["a", "b", "c", "d", "e", "f"].map((x) => idea(`t${x}x`)) }, t)).status).toBe(400);
    expect((await post("/api/launch/batch", { ideas: [idea("delta")] }, null)).status).toBe(401);
    expect((await app.request("/api/site/nosuch")).status).toBe(404);
  });
});

describe("token icon", () => {
  test("is a small svg data uri", async () => {
    const { tokenIconDataUri, tokenIconSvg } = await import("./icon");
    const i = { ticker: "soak", colors: { primary: "#FFB347", secondary: "#87CEEB", accent: "#FF6B6B", background: "#FDF5E6", text: "#4A3728" } };
    expect(tokenIconSvg(i)).toContain("SOAK");
    expect(tokenIconDataUri(i).length).toBeLessThan(1200);
  });
});

describe("slugs", () => {
  test("slugify", async () => {
    const { slugify } = await import("@osl/schema");
    expect(slugify("Quack Chaos")).toBe("quack-chaos");
    expect(slugify("YeetDuck Left")).toBe("yeetduck-left");
    expect(slugify("  Café   Crème!! ")).toBe("cafe-creme");
    expect(slugify("$DOGE -- to the 🌙 moon")).toBe("doge-to-the-moon");
    expect(slugify("🚀🚀")).toBe("");
    const long = slugify("A very very long token name that keeps going and going forever");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("-")).toBe(false);
  });

  test("collision suffix", async () => {
    const { claimSlug } = await import("./sites");
    const m = new Map<string, string>();
    const kv = { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) };
    expect(await claimSlug("Moon Cat", "mooncat", kv)).toBe("moon-cat");
    m.set("slug:moon-cat", "mooncat");
    expect(await claimSlug("Moon Cat", "mooncat", kv)).toBe("moon-cat"); // same token keeps it
    expect(await claimSlug("Moon Cat", "mcat", kv)).toBe("moon-cat-2");
    m.set("slug:moon-cat-2", "mcat");
    expect(await claimSlug("Moon  Cat!", "mc3", kv)).toBe("moon-cat-3");
    expect(await claimSlug("🚀", "rkt", kv)).toBe("rkt");
  });

  test("launches resolve by slug and ticker", async () => {
    const t = await session("ivy.testnet");
    const idea = (ticker: string, name: string) => ({
      name, ticker, tagline: "slug test token", description: "Two tokens with the same name get distinct slugs.",
      colors: { primary: "#ff4fa3", secondary: "#4cc9f0", accent: "#c6f432", background: "#1b1433", text: "#fff3dc" },
    });
    const r = await post("/api/launch/batch", { ideas: [idea("slugone", "Same Name"), idea("slugtwo", "Same Name")] }, t);
    const j = await r.json();
    expect(j.results.map((x: { siteUrl: string }) => x.siteUrl)).toEqual(["https://yeetpad.fun/t/same-name", "https://yeetpad.fun/t/same-name-2"]);
    const bySlug = await (await app.request("/api/site/same-name-2")).json();
    expect(bySlug.siteConfig.branding.ticker).toBe("SLUGTWO");
    const byTicker = await (await app.request("/api/site/slugtwo")).json();
    expect(byTicker.siteUrl).toBe("https://yeetpad.fun/t/same-name-2");
    const mine = await (await app.request("/api/launches/ivy.testnet")).json();
    expect(mine.launches.map((l: { slug: string }) => l.slug)).toEqual(["same-name-2", "same-name"]);
  });
});

describe("creator site settings", () => {
  test("GA id validation", async () => {
    const { SiteSettingsRequest, GA_ID_RE } = await import("@osl/schema");
    for (const ok of ["G-TEST1234", "g-abcd1234", " G-ABCD ", "G-ABCDEFGHIJ12"]) expect(SiteSettingsRequest.safeParse({ gaId: ok }).success).toBe(true);
    for (const bad of ["UA-12345-1", "G-ABC", "G-ABCDEFGHIJ123", "G-TEST1234'</script>", "G-TE ST", "GTM-ABCD12", 42])
      expect(SiteSettingsRequest.safeParse({ gaId: bad }).success).toBe(false);
    expect(SiteSettingsRequest.safeParse({ gaId: null }).success).toBe(true);
    expect(SiteSettingsRequest.parse({ gaId: "g-abcd1234" }).gaId).toBe("G-ABCD1234");
    expect(GA_ID_RE.test("G-TEST1234<x>")).toBe(false);
  });

  test("owner-only settings", async () => {
    const owner = await session("jade.testnet");
    const other = await session("mallory.testnet");
    const idea = {
      name: "Settings Token", ticker: "settok", tagline: "settings test", description: "Owner-only settings endpoint test token.",
      colors: { primary: "#ff4fa3", secondary: "#4cc9f0", accent: "#c6f432", background: "#1b1433", text: "#fff3dc" },
    };
    expect((await post("/api/launch/batch", { ideas: [idea] }, owner)).status).toBe(200);
    const put = (id: string, body: unknown, t: string | null) =>
      app.request(`/api/site/${id}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
        body: JSON.stringify(body),
      });
    expect((await put("settings-token", { gaId: "G-TEST1234" }, null)).status).toBe(401);
    expect((await put("settings-token", { gaId: "G-TEST1234" }, other)).status).toBe(403);
    expect((await put("settings-token", { gaId: "<script>" }, owner)).status).toBe(400);
    expect((await put("no-such-token", { gaId: "G-TEST1234" }, owner)).status).toBe(404);
    const ok = await put("settings-token", { gaId: "G-TEST1234" }, owner);
    expect(ok.status).toBe(200);
    expect((await (await app.request("/api/site/settok")).json()).siteConfig.analytics.gaId).toBe("G-TEST1234");
    const mine = await (await app.request("/api/launches/jade.testnet")).json();
    expect(mine.launches[0].gaId).toBe("G-TEST1234");
    expect(mine.launches[0].views).toBe(0);
    expect((await put("settok", { gaId: null }, owner)).status).toBe(200);
    expect((await (await app.request("/api/site/settings-token")).json()).siteConfig.analytics).toBeUndefined();
  });
});

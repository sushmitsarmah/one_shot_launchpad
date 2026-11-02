import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { LooftaPayTo } from "@osl/schema";
import { signIn } from "./test-helpers";
import { isCheckoutUrl, looftaKeyKey, looftaPageKey, looftaPayKey, maskEmail, sendUrl } from "./loofta";
import { kvStore } from "./sites";

const RECIPIENT = "launch-vault.loofta.testnet";
const MASTER = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const GOOD = "lft_live_GOODkey0123456789abcdWXYZ";
const BAD = "lft_live_BADkey00000000000000000000";
const EMAIL = "jane.creator@example.com";
const idea = (ticker: string) => ({ name: `${ticker} coin`, ticker, tagline: "pay me", description: "A Loofta test token.", colors: { primary: "#ff4fa3", secondary: "#4cc9f0", accent: "#c6f432", background: "#1b1433", text: "#fff3dc" } });

let app: typeof import("./app").app;
let configureFromEnv: typeof import("./config").configureFromEnv;
const realFetch = globalThis.fetch;
const calls: { url: string; method: string; auth: string | null; body?: string }[] = [];
const logs: string[] = [];
const realLog = console.log;
const realErr = console.error;
const env = (NEAR_NETWORK: string) =>
  configureFromEnv({ LLM_MOCK: "1", NEAR_MOCK: "1", SESSION_SECRET: "loofta-secret", VAULT_CONTRACT: RECIPIENT, LOCKED: "0", ADMIN_ACCOUNTS: "boss-lft.testnet", KEY_ENCRYPTION_KEY: MASTER, NEAR_NETWORK, AUTH_RECIPIENT: RECIPIENT });

beforeAll(async () => {
  ({ app } = await import("./app"));
  ({ configureFromEnv } = await import("./config"));
  env("testnet");
  globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u instanceof Request ? u.url : u);
    if (!url.startsWith("https://api.loofta.com/")) return realFetch(u as RequestInfo, init);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, method: init?.method ?? "GET", auth, body: init?.body as string | undefined });
    if (init?.redirect !== "manual") return new Response("must not follow redirects", { status: 500 });
    if (auth !== `Bearer ${GOOD}`) return new Response(JSON.stringify({ message: `Invalid or revoked integrator API key ${auth}` }), { status: 401 });
    if (url.includes("/payment-links/")) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    if (url.endsWith("/payment-links") && init?.method === "POST") return new Response(JSON.stringify({ short_id: "abc123", url: "https://pay.loofta.com/checkout/abc123", amount: JSON.parse(String(init.body)).amount }));
    return new Response("?", { status: 400 });
  }) as typeof fetch;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
});
afterAll(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realErr;
  configureFromEnv({ LLM_MOCK: "1", NEAR_MOCK: "1", LOCKED: "0" });
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
const call = (method: string, path: string, body?: unknown, token?: string | null) =>
  app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

describe("loofta helpers", () => {
  test("payout targets validate", () => {
    expect(LooftaPayTo.safeParse({ kind: "email", value: " Jane@Example.com " }).data).toEqual({ kind: "email", value: "jane@example.com" });
    expect(LooftaPayTo.safeParse({ kind: "email", value: "nope" }).success).toBe(false);
    expect(LooftaPayTo.safeParse({ kind: "social", platform: "twitter", value: "@yeet_er" }).data).toEqual({ kind: "social", platform: "twitter", value: "yeet_er" });
    expect(LooftaPayTo.safeParse({ kind: "social", platform: "twitter", value: "way_too_long_handle_x" }).success).toBe(false);
    expect(LooftaPayTo.safeParse({ kind: "social", platform: "telegram", value: "abc" }).success).toBe(false);
    expect(LooftaPayTo.safeParse({ kind: "social", platform: "myspace", value: "abc" }).success).toBe(false);
    expect(LooftaPayTo.safeParse({ kind: "username", value: "@Alice" }).data).toEqual({ kind: "username", value: "alice" });
    expect(LooftaPayTo.safeParse({ kind: "username", value: "a b" }).success).toBe(false);
    expect(LooftaPayTo.safeParse({ kind: "solana", value: "So1111" }).success).toBe(false);
    expect(LooftaPayTo.safeParse({ kind: "email", value: "a@b.co", extra: 1 }).success).toBe(false);
  });
  test("urls and masking", () => {
    expect(sendUrl({ kind: "email", value: "a+b@x.io" }, 5)).toBe("https://pay.loofta.com/app?tab=send&to=a%2Bb%40x.io&method=email&amount=5");
    expect(sendUrl({ kind: "social", platform: "github", value: "octo" }, 2.5)).toBe("https://pay.loofta.com/app?tab=send&to=octo&method=social&platform=github&amount=2.5");
    expect(sendUrl({ kind: "username", value: "alice" }, 10)).toBe("https://pay.loofta.com/app?tab=send&payto=alice&amount=10");
    expect(maskEmail("jane@example.com")).toBe("j•••@example.com");
    expect(isCheckoutUrl("https://pay.loofta.com/checkout/abc123")).toBe(true);
    expect(isCheckoutUrl("https://evil.example/checkout/abc123")).toBe(false);
    expect(isCheckoutUrl("http://pay.loofta.com/checkout/abc123")).toBe(false);
    expect(isCheckoutUrl("https://pay.loofta.com/app?x=1")).toBe(false);
  });
});

describe("loofta api", () => {
  test("settings, key (write-only), payout target, bulk toggle, page config, checkout preview; nothing secret leaks", async () => {
    const owner = await session("lena.testnet");
    const other = await session("otto.testnet");
    const kv = kvStore();
    const r = await call("POST", "/api/launch/batch", { ideas: [idea("lftone"), idea("lfttwo")] }, owner);
    expect(r.status).toBe(200);
    const slug = (await r.json()).results[0].slug as string;

    // off by default; settings empty
    expect((await (await app.request(`/api/site/${slug}`)).json()).loofta).toBeNull();
    const s0 = await (await call("GET", "/api/loofta/settings", undefined, owner)).json();
    expect(s0).toMatchObject({ enabled: true, key: null, payTo: null, route: null, network: "testnet" });
    expect((await call("GET", "/api/loofta/settings")).status).toBe(401);

    // can't enable before a key or target exists: clear message
    const early = await call("POST", "/api/tokens/loofta", { tokens: ["lftone"], loofta: { enabled: true } }, owner);
    expect(early.status).toBe(409);
    expect((await early.json()).error).toMatch(/set up Loofta first/);

    // keyless route: creator's payout target (email), stored encrypted, masked for the owner, hidden from visitors
    expect((await call("PUT", "/api/loofta/payto", { payTo: { kind: "email", value: "bad" } }, owner)).status).toBe(400);
    const pt = await (await call("PUT", "/api/loofta/payto", { payTo: { kind: "email", value: EMAIL } }, owner)).json();
    expect(pt.payTo).toEqual({ kind: "email", display: "j•••@example.com" });
    expect(pt.route).toBe("send");
    expect(await kv.get(looftaPayKey("lena.testnet"))).not.toContain("example.com");

    // bulk toggle: creator only
    expect((await call("POST", "/api/tokens/loofta", { tokens: ["lftone"], loofta: { enabled: true } }, other)).status).toBe(403);
    expect((await call("POST", "/api/tokens/loofta", { tokens: ["lftone"], loofta: { enabled: true } }, null)).status).toBe(401);
    expect((await call("POST", "/api/tokens/loofta", { tokens: Array.from({ length: 51 }, (_, i) => `tk${i}x`), loofta: { enabled: true } }, owner)).status).toBe(400);
    const on = await call("POST", "/api/tokens/loofta", { tokens: ["lftone", "nosuchtk"], loofta: { enabled: true } }, owner);
    expect(on.status).toBe(200);
    expect((await on.json()).results.map((x: { ok: boolean }) => x.ok)).toEqual([true, false]);

    const site = await app.request(`/api/site/${slug}`);
    const siteText = await site.text();
    const sj = JSON.parse(siteText);
    expect(sj.loofta).toEqual({ enabled: true, route: "send", label: "the creator (by email)", preview: true });
    expect(sj.siteConfig.loofta).toBeUndefined();
    const launchesText = await (await app.request("/api/launches/lena.testnet")).text();
    const mine = JSON.parse(launchesText).launches as { ticker: string; loofta?: unknown }[];
    expect(mine.find((l) => l.ticker === "lftone")?.loofta).toEqual({ enabled: true, ready: true, custom: false });
    expect(mine.find((l) => l.ticker === "lfttwo")?.loofta).toBeUndefined();
    for (const t of [siteText, launchesText]) expect(t).not.toContain("example.com");

    // checkout on testnet: preview, no URL, no Loofta call, no email
    const n0 = calls.length;
    const co = await call("POST", "/api/loofta/checkout", { site: slug, amount: 5 });
    const coText = await co.text();
    expect(co.status).toBe(200);
    expect(JSON.parse(coText)).toMatchObject({ preview: true, url: null, route: "send", amount: 5 });
    expect(coText).not.toContain("example.com");
    expect(calls.length).toBe(n0);
    expect((await call("POST", "/api/loofta/checkout", { site: slug, amount: 0.5 })).status).toBe(400);
    expect((await call("POST", "/api/loofta/checkout", { site: slug, amount: 1.234 })).status).toBe(400);
    expect((await call("POST", "/api/loofta/checkout", { site: "lfttwo", amount: 5 })).status).toBe(403);

    // per-page override (social handle) wins over the default
    expect((await call("POST", "/api/tokens/loofta", { tokens: ["lftone"], loofta: { enabled: true, payTo: { kind: "social", platform: "twitter", value: "@lena_x" } } }, owner)).status).toBe(200);
    expect((await (await app.request(`/api/site/${slug}`)).json()).loofta.label).toBe("@lena_x on X");
    expect(await kv.get(looftaPageKey("lftone"))).not.toContain("lena_x");

    // key: format check, rejected key is not stored, Loofta error text never echoed
    expect((await call("PUT", "/api/loofta/key", { apiKey: "sk-not-loofta" }, owner)).status).toBe(400);
    const bad = await call("PUT", "/api/loofta/key", { apiKey: BAD }, owner);
    const badText = await bad.text();
    expect(bad.status).toBe(400);
    expect(badText).toMatch(/not saved/);
    expect(badText).not.toContain(BAD);
    expect(await kv.get(looftaKeyKey("lena.testnet"))).toBeNull();
    const good = await call("PUT", "/api/loofta/key", { apiKey: GOOD }, owner);
    const goodText = await good.text();
    expect(good.status).toBe(200);
    expect(goodText).not.toContain(GOOD.slice(0, -4));
    const gj = JSON.parse(goodText);
    expect(gj.key).toMatchObject({ last4: "WXYZ", valid: true });
    expect(gj.route).toBe("checkout");
    expect(calls.at(-1)).toMatchObject({ method: "GET", auth: `Bearer ${GOOD}` });
    expect(calls.at(-1)!.url).toMatch(/^https:\/\/api\.loofta\.com\/payment-links\/yeetcheck[0-9a-f]+$/);
    expect(await kv.get(looftaKeyKey("lena.testnet"))).not.toContain(GOOD);
    const tst = await (await call("POST", "/api/loofta/key/test", undefined, owner)).json();
    expect(tst.ok).toBe(true);

    // clearing the page override: key route; visitors see only "the creator's Loofta account"
    expect((await call("POST", "/api/tokens/loofta", { tokens: ["lftone"], loofta: { enabled: true, payTo: null } }, owner)).status).toBe(200);
    expect((await (await app.request(`/api/site/${slug}`)).json()).loofta).toEqual({ enabled: true, route: "checkout", label: "the creator's Loofta account", preview: true });
    const n1 = calls.length;
    const pre = await (await call("POST", "/api/loofta/checkout", { site: slug, amount: 7 })).json();
    expect(pre).toMatchObject({ preview: true, url: null, route: "checkout" });
    expect(calls.length).toBe(n1); // testnet: no payment link is created

    // mainnet behaviour (config only; Loofta is stubbed): a fresh checkout link with the owner's key, and the Send link
    env("mainnet");
    try {
      const live = await (await call("POST", "/api/loofta/checkout", { site: slug, amount: 7, message: "gm\u0000 ser" })).json();
      expect(live).toMatchObject({ preview: false, route: "checkout", url: "https://pay.loofta.com/checkout/abc123" });
      expect(calls.at(-1)).toMatchObject({ method: "POST", auth: `Bearer ${GOOD}` });
      expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({ amount: 7, message: "gm ser", is_private: false });
      expect(JSON.stringify(live)).not.toContain(GOOD);
      await call("DELETE", "/api/loofta/key", undefined, owner);
      const send = await (await call("POST", "/api/loofta/checkout", { site: slug, amount: 3 })).json();
      expect(send).toMatchObject({ preview: false, route: "send", url: "https://pay.loofta.com/app?tab=send&to=jane.creator%40example.com&method=email&amount=3" });
    } finally {
      env("testnet");
    }

    // removing every route hides the widget; disabling works without a route
    await call("PUT", "/api/loofta/payto", { payTo: null }, owner);
    expect((await (await app.request(`/api/site/${slug}`)).json()).loofta).toBeNull();
    expect((await call("POST", "/api/loofta/checkout", { site: slug, amount: 3 })).status).toBe(409);
    expect((await call("POST", "/api/tokens/loofta", { tokens: ["lftone"], loofta: { enabled: false } }, owner)).status).toBe(200);
    expect(await kv.get(looftaPageKey("lftone"))).toBeFalsy();
    for (const l of logs) expect(l).not.toContain(GOOD);
  });
});

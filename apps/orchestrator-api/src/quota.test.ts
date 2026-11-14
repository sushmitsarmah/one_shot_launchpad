import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { signIn } from "./test-helpers";
import { MemoryKV } from "./sites";
import { quotaKeys, takeIdeaQuota } from "./quota";

describe("takeIdeaQuota", () => {
  const cfg = { platformIdeasPerAccountDay: 10, platformIdeasPerIpDay: 15 };
  const now = Date.UTC(2026, 10, 14, 12);
  test("per-account cap, counted in ideas, nothing counted when refused", async () => {
    const kv = new MemoryKV();
    expect((await takeIdeaQuota(kv, "a.testnet", "1.1.1.1", 5, cfg, now)).ok).toBe(true);
    expect((await takeIdeaQuota(kv, "a.testnet", "1.1.1.1", 5, cfg, now)).ok).toBe(true);
    const r = await takeIdeaQuota(kv, "a.testnet", "1.1.1.1", 1, cfg, now);
    expect(r).toEqual({ ok: false, scope: "account", limit: 10, used: 10 });
    expect(await kv.get(quotaKeys("a.testnet", "1.1.1.1", now).ip)).toBe("10");
  });
  test("per-IP cap across many fresh accounts; IPv6 shares a /64", async () => {
    const kv = new MemoryKV();
    for (let i = 0; i < 3; i++) expect((await takeIdeaQuota(kv, `n${i}.testnet`, "2001:db8:1:2::a", 5, cfg, now)).ok).toBe(true);
    const r = await takeIdeaQuota(kv, "n9.testnet", "2001:db8:1:2::ffff", 1, cfg, now);
    expect(r.ok === false && r.scope).toBe("ip");
    expect((await takeIdeaQuota(kv, "n9.testnet", "9.9.9.9", 1, cfg, now)).ok).toBe(true);
  });
  test("resets the next UTC day; 0 disables", async () => {
    const kv = new MemoryKV();
    expect((await takeIdeaQuota(kv, "a.testnet", "1.1.1.1", 10, cfg, now)).ok).toBe(true);
    expect((await takeIdeaQuota(kv, "a.testnet", "1.1.1.1", 1, cfg, now)).ok).toBe(false);
    expect((await takeIdeaQuota(kv, "a.testnet", "1.1.1.1", 1, cfg, now + 86_400_000)).ok).toBe(true);
    expect((await takeIdeaQuota(kv, "a.testnet", "1.1.1.1", 999, { platformIdeasPerAccountDay: 0, platformIdeasPerIpDay: 0 }, now)).ok).toBe(true);
  });
});

describe("POST /api/generate with the platform key", () => {
  const RECIPIENT = "launch-vault.quota.testnet";
  let app: typeof import("./app").app;
  let configureFromEnv: typeof import("./config").configureFromEnv;
  beforeAll(async () => {
    ({ app } = await import("./app"));
    ({ configureFromEnv } = await import("./config"));
    configureFromEnv({ LLM_MOCK: "1", NEAR_MOCK: "1", SESSION_SECRET: "quota-secret", VAULT_CONTRACT: RECIPIENT, LOCKED: "0", ADMIN_ACCOUNTS: "boss.testnet", PLATFORM_IDEAS_PER_ACCOUNT_DAY: "4", PLATFORM_IDEAS_PER_IP_DAY: "6" });
  });
  afterAll(() => configureFromEnv({ LOCKED: "0" }));
  const req = (path: string, body: unknown, token?: string, ip = "203.0.113.7") =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const token = async (account: string) => (await (await req("/api/auth/session", await signIn(KeyPair.fromRandom("ed25519"), account, RECIPIENT))).json()).token as string;

  test("a stranger hits the account cap with 429 platform_quota; admins are exempt", async () => {
    const t = await token("stranger-q.testnet");
    expect((await req("/api/generate", { prompt: "quota cats", count: 4 }, t)).status).toBe(200);
    const r = await req("/api/generate", { prompt: "quota cats", count: 1 }, t);
    expect(r.status).toBe(429);
    const j = await r.json();
    expect(j.code).toBe("platform_quota");
    expect(j.scope).toBe("account");
    const b = await token("boss.testnet");
    for (let i = 0; i < 3; i++) expect((await req("/api/generate", { prompt: "admin cats", count: 5 }, b, "198.51.100.1")).status).toBe(200);
  });
  test("fresh accounts from one IP share the IP cap", async () => {
    const ip = "192.0.2.50";
    expect((await req("/api/generate", { prompt: "ip cats", count: 4 }, await token("fresh-1.testnet"), ip)).status).toBe(200);
    expect((await req("/api/generate", { prompt: "ip cats", count: 2 }, await token("fresh-2.testnet"), ip)).status).toBe(200);
    const r = await req("/api/generate", { prompt: "ip cats", count: 1 }, await token("fresh-3.testnet"), ip);
    expect(r.status).toBe(429);
    expect((await r.json()).scope).toBe("ip");
  });
});

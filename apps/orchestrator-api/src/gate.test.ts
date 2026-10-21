import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { NOT_WHITELISTED, WaitlistRequest } from "@osl/schema";
import { signIn } from "./test-helpers";
import { NOT_ADMIN } from "@osl/schema";
import { addToWaitlist, allowKey, approveAccounts, ipBucket, isAllowed, listAll, listWaitlist, takeRateLimit, waitlistKey, WAITLIST_RATE_LIMIT } from "./gate";
import { MemoryKV, kvStore, type KVLike } from "./sites";

const RECIPIENT = "launch-vault.gate.testnet";
const ALLOWED = "osl-e2e-mvhxupmb.testnet";
const ADMIN = "boss.testnet";
let app: typeof import("./app").app;
let configureFromEnv: typeof import("./config").configureFromEnv;

beforeAll(async () => {
  ({ app } = await import("./app"));
  ({ configureFromEnv } = await import("./config"));
  configureFromEnv({
    LLM_MOCK: "1",
    NEAR_MOCK: "1",
    SESSION_SECRET: "gate-secret",
    VAULT_CONTRACT: RECIPIENT,
    LOCKED: "1",
    ALLOWED_ACCOUNTS: ` ${ALLOWED} , Second.testnet `,
    ADMIN_ACCOUNTS: ADMIN,
  });
});
afterAll(() => configureFromEnv({ LOCKED: "0" }));

const json = (path: string, body: unknown, init: RequestInit & { token?: string; ip?: string } = {}) =>
  app.request(path, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.ip ? { "cf-connecting-ip": init.ip } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function sessionFor(account: string) {
  return json("/api/auth/session", await signIn(KeyPair.fromRandom("ed25519"), account, RECIPIENT));
}

describe("isAllowed", () => {
  const cfg = { locked: true, allowedAccounts: ["a.testnet", "b.testnet"], adminAccounts: ["root.testnet"] };
  test("locked: env allowlist, admins and KV approvals", async () => {
    const kv = new MemoryKV();
    await kv.put(allowKey("k.testnet"), "{}");
    expect(await isAllowed("a.testnet", cfg, kv)).toBe(true);
    expect(await isAllowed("A.testnet ", cfg, kv)).toBe(true);
    expect(await isAllowed("root.testnet", cfg, kv)).toBe(true);
    expect(await isAllowed("k.testnet", cfg, kv)).toBe(true);
    expect(await isAllowed("c.testnet", cfg, kv)).toBe(false);
    expect(await isAllowed("a.testnet.evil", cfg, kv)).toBe(false);
    expect(await isAllowed("a.testnet", { locked: true, allowedAccounts: [] }, kv)).toBe(false);
  });
  test("unlocked: everyone", async () => {
    expect(await isAllowed("c.testnet", { ...cfg, locked: false }, new MemoryKV())).toBe(true);
  });
});

describe("config", () => {
  test("LOCKED defaults on and parses the allowlist", async () => {
    const { buildConfig } = await import("./config");
    expect(buildConfig({}).locked).toBe(true);
    expect(buildConfig({ LOCKED: "0" }).locked).toBe(false);
    expect(buildConfig({ LOCKED: "false" }).locked).toBe(false);
    expect(buildConfig({ LOCKED: "1" }).locked).toBe(true);
    expect(buildConfig({ ALLOWED_ACCOUNTS: " X.testnet, ,y.testnet" }).allowedAccounts).toEqual(["x.testnet", "y.testnet"]);
    expect(buildConfig({}).allowedAccounts).toEqual([]);
  });
});

describe("gate (locked)", () => {
  test("health reports locked, without the allowlist", async () => {
    const j = await (await app.request("/api/health")).json();
    expect(j.locked).toBe(true);
    expect(JSON.stringify(j)).not.toContain(ALLOWED);
  });

  test("unlisted account: session is 403 not_whitelisted", async () => {
    const r = await sessionFor("random-person.testnet");
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.code).toBe(NOT_WHITELISTED);
  });

  test("bad signature is still 401 (allowlist not probeable)", async () => {
    const req = await signIn(KeyPair.fromRandom("ed25519"), ALLOWED, RECIPIENT);
    const r = await json("/api/auth/session", { ...req, accountId: "random-person.testnet" });
    expect(r.status).toBe(401);
  });

  test("allowlisted accounts get a session and can generate", async () => {
    for (const acc of [ALLOWED, "second.testnet"]) {
      const r = await sessionFor(acc);
      expect(r.status).toBe(200);
    }
    const { token } = await (await sessionFor(ALLOWED)).json();
    const g = await json("/api/generate", { prompt: "allowed ducks", ownerWallet: ALLOWED }, { token });
    expect(g.status).toBe(200);
  });

  test("existing sessions of unlisted accounts are rejected on spend/launch/settings", async () => {
    // Issue a session while unlocked, then lock again (simulates a session from before the lock).
    configureFromEnv({ SESSION_SECRET: "gate-secret", VAULT_CONTRACT: RECIPIENT, NEAR_MOCK: "1", LLM_MOCK: "1", LOCKED: "0" });
    const s = await sessionFor("old-user.testnet");
    expect(s.status).toBe(200);
    const { token } = await s.json();
    configureFromEnv({ SESSION_SECRET: "gate-secret", VAULT_CONTRACT: RECIPIENT, NEAR_MOCK: "1", LLM_MOCK: "1", LOCKED: "1", ALLOWED_ACCOUNTS: ALLOWED, ADMIN_ACCOUNTS: ADMIN });

    const idea = { name: "Old Duck", ticker: "oldduck", tagline: "t", description: "d", colors: { primary: "#111111", secondary: "#222222", accent: "#333333", background: "#ffffff", text: "#000000" } };
    const cases: [string, string, unknown][] = [
      ["POST", "/api/generate", { prompt: "old user tries", ownerWallet: "old-user.testnet" }],
      ["POST", "/api/launch", { ownerWallet: "old-user.testnet", idea }],
      ["POST", "/api/launch/batch", { ownerWallet: "old-user.testnet", ideas: [idea] }],
      ["PUT", "/api/site/oldduck/settings", { gaId: null }],
    ];
    for (const [method, path, body] of cases) {
      const r = await json(path, body, { method, token });
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe(NOT_WHITELISTED);
    }
  });

  test("public reads keep working", async () => {
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/launches/random-person.testnet")).status).toBe(200);
    expect((await app.request("/api/site/nosuchtoken")).status).toBe(404);
  });
});

describe("whitelist validation", () => {
  const ok = (v: unknown) => WaitlistRequest.safeParse(v).success;
  test("account must be a NEAR id", () => {
    expect(ok({ account: "alice.testnet" })).toBe(true);
    expect(ok({ account: "  Alice.Testnet " })).toBe(true);
    expect(WaitlistRequest.parse({ account: " Alice.testnet" }).account).toBe("alice.testnet");
    expect(ok({ account: "a" })).toBe(false);
    expect(ok({ account: "bad account!" })).toBe(false);
    expect(ok({ account: "x".repeat(65) })).toBe(false);
    expect(ok({})).toBe(false);
  });
  test("contact is optional email or @handle, length limited", () => {
    expect(ok({ account: "alice.testnet", contact: "a@b.co" })).toBe(true);
    expect(ok({ account: "alice.testnet", contact: "@yeet_er" })).toBe(true);
    expect(ok({ account: "alice.testnet", contact: "" })).toBe(true);
    expect(ok({ account: "alice.testnet", contact: null })).toBe(true);
    expect(ok({ account: "alice.testnet", contact: "not a contact" })).toBe(false);
    expect(ok({ account: "alice.testnet", contact: "<b>@x.yz" })).toBe(false);
    expect(ok({ account: "alice.testnet", contact: `${"a".repeat(95)}@b.com` })).toBe(false);
    expect(ok({ account: "alice.testnet", contact: `@${"a".repeat(51)}` })).toBe(false);
  });
});

describe("POST /api/whitelist", () => {
  test("stores waitlist:<account> and is idempotent", async () => {
    const r1 = await json("/api/whitelist", { account: "Wait-One.testnet", contact: "@waiter" }, { ip: "1.1.1.1" });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true, account: "wait-one.testnet", already: false });
    const stored = JSON.parse((await kvStore().get(waitlistKey("wait-one.testnet")))!);
    expect(stored.contact).toBe("@waiter");
    const r2 = await json("/api/whitelist", { account: "wait-one.testnet" }, { ip: "1.1.1.1" });
    expect((await r2.json()).already).toBe(true);
    const again = JSON.parse((await kvStore().get(waitlistKey("wait-one.testnet")))!);
    expect(again.createdAt).toBe(stored.createdAt);
    expect(again.contact).toBe("@waiter");
  });

  test("rejects bad input and oversized bodies", async () => {
    expect((await json("/api/whitelist", { account: "no way" }, { ip: "2.2.2.2" })).status).toBe(400);
    expect((await json("/api/whitelist", "not json", { ip: "2.2.2.2" })).status).toBe(400);
    expect((await json("/api/whitelist", { account: "ok.testnet", contact: "x".repeat(2000) }, { ip: "2.2.2.2" })).status).toBe(413);
  });

  test("rate limits per IP", async () => {
    for (let i = 0; i < WAITLIST_RATE_LIMIT; i++) {
      expect((await json("/api/whitelist", { account: `rl-${i}.testnet` }, { ip: "9.9.9.9" })).status).toBe(200);
    }
    expect((await json("/api/whitelist", { account: "rl-over.testnet" }, { ip: "9.9.9.9" })).status).toBe(429);
    expect((await json("/api/whitelist", { account: "rl-other.testnet" }, { ip: "8.8.8.8" })).status).toBe(200);
    // rotating addresses inside one IPv6 /64 share a bucket
    for (let i = 0; i < WAITLIST_RATE_LIMIT; i++) {
      expect((await json("/api/whitelist", { account: `rl6-${i}.testnet` }, { ip: `2a04:4e41:80:2614::${i + 1}` })).status).toBe(200);
    }
    expect((await json("/api/whitelist", { account: "rl6-over.testnet" }, { ip: "2a04:4e41:80:2614::ffff" })).status).toBe(429);
  });

  test("no public listing endpoint", async () => {
    expect((await app.request("/api/whitelist")).status).toBe(404);
  });
});

describe("waitlist store helpers", () => {
  const mem = (): KVLike => {
    const m = new Map<string, string>();
    return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
  };
  test("later contact updates, timestamp kept", async () => {
    const kv = mem();
    const a = await addToWaitlist(kv, { account: "x.testnet" }, 1000);
    expect(a.already).toBe(false);
    const b = await addToWaitlist(kv, { account: "x.testnet", contact: "x@y.io" }, 2000);
    expect(b.already).toBe(true);
    expect(b.entry).toEqual({ account: "x.testnet", contact: "x@y.io", createdAt: 1000, updatedAt: 2000, status: "pending" });
  });
  test("IPv6 is bucketed by /64", () => {
    expect(ipBucket("1.2.3.4")).toBe("1.2.3.4");
    expect(ipBucket("2a04:4e41:80:2614::314d:2614")).toBe("2a04:4e41:80:2614::/64");
    expect(ipBucket("2a04:4e41:0080:2614:1:2:3:4")).toBe("2a04:4e41:80:2614::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
  });
  test("rate limit window resets", async () => {
    const kv = mem();
    expect(await takeRateLimit(kv, "ip", 0, 1, 60)).toBe(true);
    expect(await takeRateLimit(kv, "ip", 1000, 1, 60)).toBe(false);
    expect(await takeRateLimit(kv, "ip", 61_000, 1, 60)).toBe(true);
  });
});

describe("KV list pagination", () => {
  test("listAll follows cursors", async () => {
    const kv = new MemoryKV();
    for (let i = 0; i < 2500; i++) await kv.put(`waitlist:p${String(i).padStart(4, "0")}.testnet`, "{}");
    await kv.put("other:x", "{}");
    const r = await listAll(kv, "waitlist:");
    expect(r.keys.length).toBe(2500);
    expect(r.truncated).toBe(false);
    expect((await listAll(kv, "waitlist:", 2)).truncated).toBe(true);
  });
  test("listWaitlist falls back to reads for entries without metadata", async () => {
    const kv = new MemoryKV();
    await kv.put(waitlistKey("old.testnet"), JSON.stringify({ account: "old.testnet", contact: null, createdAt: 5, updatedAt: 5 }));
    await addToWaitlist(kv, { account: "new.testnet", contact: "@n" }, 10);
    await approveAccounts(kv, ["old.testnet"], "boss.testnet", 20);
    const { entries } = await listWaitlist(kv, { locked: true, allowedAccounts: [] });
    expect(entries.map((e) => [e.account, e.status])).toEqual([["new.testnet", "pending"], ["old.testnet", "approved"]]);
    expect(entries[1].approvedBy).toBe("boss.testnet");
  });
});

describe("admin API", () => {
  const authed = async (account: string) => (await (await sessionFor(account)).json()).token as string;
  const get = (path: string, token?: string) => app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  test("/api/auth/me reports isAdmin + whitelisted", async () => {
    const admin = await (await get("/api/auth/me", await authed(ADMIN))).json();
    expect(admin).toEqual({ accountId: ADMIN, isAdmin: true, whitelisted: true, locked: true });
    const user = await (await get("/api/auth/me", await authed(ALLOWED))).json();
    expect(user.isAdmin).toBe(false);
    expect(user.whitelisted).toBe(true);
  });

  test("non-admins get 403 not_admin, no session 401", async () => {
    const token = await authed(ALLOWED);
    for (const [m, p] of [["GET", "/api/admin/waitlist"], ["GET", "/api/admin/allowed"], ["POST", "/api/admin/approve"], ["POST", "/api/admin/revoke"], ["POST", "/api/admin/remove"]]) {
      const r = await json(p, { accounts: ["x.testnet"] }, { method: m, token });
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe(NOT_ADMIN);
      expect((await json(p, { accounts: ["x.testnet"] }, { method: m })).status).toBe(401);
    }
  });

  test("approve -> session works; revoke -> 403 again (incl. existing session); remove deletes the request", async () => {
    const admin = await authed(ADMIN);
    const who = "gate-flow.testnet";
    await json("/api/whitelist", { account: who, contact: "@flow" }, { ip: "5.5.5.5" });
    await json("/api/whitelist", { account: "gate-other.testnet" }, { ip: "5.5.5.5" });
    expect((await sessionFor(who)).status).toBe(403);

    let list = await (await get("/api/admin/waitlist", admin)).json();
    expect(list.entries.find((e: any) => e.account === who)).toMatchObject({ status: "pending", contact: "@flow" });

    const ap = await (await json("/api/admin/approve", { accounts: [who] }, { token: admin })).json();
    expect(ap.results).toEqual([{ account: who, ok: true }]);
    const s = await sessionFor(who);
    expect(s.status).toBe(200);
    const userToken = (await s.json()).token;
    list = await (await get("/api/admin/waitlist", admin)).json();
    expect(list.entries.find((e: any) => e.account === who)).toMatchObject({ status: "approved", approvedBy: ADMIN });
    expect(list.counts.approved).toBeGreaterThanOrEqual(1);
    const allowed = await (await get("/api/admin/allowed", admin)).json();
    expect(allowed.allowed.map((a: any) => [a.account, a.source])).toContainEqual([who, "kv"]);
    expect(allowed.allowed.map((a: any) => [a.account, a.source])).toContainEqual([ADMIN, "admin"]);

    await json("/api/admin/revoke", { accounts: [who] }, { token: admin });
    expect((await sessionFor(who)).status).toBe(403);
    const g = await json("/api/generate", { prompt: "revoked user", ownerWallet: who }, { token: userToken });
    expect(g.status).toBe(403);
    list = await (await get("/api/admin/waitlist", admin)).json();
    expect(list.entries.find((e: any) => e.account === who).status).toBe("revoked");

    await json("/api/admin/approve", { accounts: [who] }, { token: admin });
    const rm = await (await json("/api/admin/remove", { accounts: [who] }, { token: admin })).json();
    expect(rm.results[0].ok).toBe(true);
    expect(await kvStore().get(waitlistKey(who))).toBeNull();
    expect(await kvStore().get(allowKey(who))).toBeNull();
    expect((await sessionFor(who)).status).toBe(403);
  });

  test("approving an account that never joined still works; env accounts can't be revoked via KV", async () => {
    const admin = await authed(ADMIN);
    const r = await (await json("/api/admin/approve", { accounts: ["Walk-In.testnet"] }, { token: admin })).json();
    expect(r.results[0]).toMatchObject({ account: "walk-in.testnet", ok: true });
    expect((await sessionFor("walk-in.testnet")).status).toBe(200);
    const rv = await (await json("/api/admin/revoke", { accounts: [ALLOWED, ADMIN] }, { token: admin })).json();
    expect(rv.results.map((x: any) => x.ok)).toEqual([false, false]);
    expect((await sessionFor(ALLOWED)).status).toBe(200);
  });

  test("bad admin bodies are 400", async () => {
    const admin = await authed(ADMIN);
    expect((await json("/api/admin/approve", { accounts: [] }, { token: admin })).status).toBe(400);
    expect((await json("/api/admin/approve", { accounts: ["no way"] }, { token: admin })).status).toBe(400);
    expect((await json("/api/admin/approve", { accounts: Array.from({ length: 101 }, (_, i) => `a${i}.testnet`) }, { token: admin })).status).toBe(400);
  });
});

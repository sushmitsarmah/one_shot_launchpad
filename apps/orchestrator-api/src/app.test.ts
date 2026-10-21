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
  ({ app } = await import("./app"));
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

  test("batch launch, site pages and my launches", async () => {
    const t = await session("hank.testnet");
    const r = await post("/api/launch/batch", { ideas: [idea("alpha"), idea("beta")] }, t);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true]);
    expect(j.results[0].siteUrl).toBe("https://yeetpad.fun/t/alpha");

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

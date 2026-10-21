import { beforeAll, describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { LaunchResponse, NearlyPrepareResponse, QuoteResponse } from "@osl/schema";
import { signIn } from "./test-helpers";
import { computePoints, fdvAtPoint } from "./rhea";

let app: typeof import("./app").app;
const RECIPIENT = "launch-vault.mock.testnet";
beforeAll(async () => {
  process.env.LLM_MOCK = "1";
  process.env.NEAR_MOCK = "1";
  process.env.SESSION_SECRET = "test-secret";
  process.env.VAULT_CONTRACT = RECIPIENT;
  process.env.LOCKED = "0";
  process.env.NEARLY_ENABLED = "1";
  ({ app } = await import("./app"));
  (await import("./config")).configureFromEnv({});
});

async function token(account: string) {
  const req = await signIn(KeyPair.fromRandom("ed25519"), account, RECIPIENT);
  const r = await app.request("/api/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  return (await r.json()).token as string;
}
const post = (path: string, body: unknown, t: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify(body) });
const idea = async (t: string) => (await (await post("/api/generate", { prompt: "venue test" }, t)).json()).idea;

describe("rhea math", () => {
  const S = 10n ** 27n;
  test("1000 NEAR FDV, 1B supply, 18 dec -> point 0 (token is X)", () => {
    const p = computePoints("aaa.factory.testnet", "wrap.testnet", 1000, S, 18);
    expect(p).toEqual({ tokenIsX: true, init: 0, left: 200, right: 500_000 });
  });
  test("token sorting after wNEAR is Y with a range at/below the price", () => {
    const p = computePoints("zzz.factory.testnet", "wrap.testnet", 1000, S, 18);
    expect(p.tokenIsX).toBe(false);
    expect(p.right).toBe(p.init);
    expect(p.left).toBe(p.init - 500_000);
  });
  test("points are on the 200 grid and round-trip the FDV within a grid step", () => {
    for (const fdv of [10, 333, 5000, 250_000]) {
      for (const id of ["aaa.f.testnet", "zzz.f.testnet"]) {
        const p = computePoints(id, "wrap.testnet", fdv, S, 18);
        expect(Math.abs(p.init % 200)).toBe(0);
        const back = fdvAtPoint(p.tokenIsX, p.init, S, 18);
        expect(Math.abs(back / fdv - 1)).toBeLessThan(0.03);
      }
    }
  });
});

describe("venues (mock mode)", () => {
  test("nearly can be switched off (503 venue_disabled)", async () => {
    const t = await token("frank.testnet");
    const { config } = await import("./config");
    config.nearlyEnabled = false;
    const r = await post("/api/nearly/prepare", { ideas: [await idea(t)] }, t);
    config.nearlyEnabled = true;
    expect(r.status).toBe(503);
  });

  test("quote: rhea adds pool + first-time DCL storage, nearly comes from quote_launch", async () => {
    const t = await token("carol.testnet");
    const ideas = [await idea(t)];
    const r = QuoteResponse.parse(await (await post("/api/quote", { ideas, listOn: "rhea" }, t)).json());
    expect(BigInt(r.total)).toBeGreaterThan(2n * 10n ** 24n);
    expect(r.items[0].parts.dcl_storage_first_time).toBeDefined();
    expect(r.rhea?.openingFdvNear).toBe(1000);
    const n = QuoteResponse.parse(await (await post("/api/quote", { ideas, listOn: "nearly" }, t)).json());
    expect(n.items[0].paidFrom).toBe("wallet");
    const none = QuoteResponse.parse(await (await post("/api/quote", { ideas, listOn: "none" }, t)).json());
    expect(BigInt(none.total)).toBeLessThan(BigInt(r.total));
  });

  test("launch with listOn rhea returns a listing", async () => {
    const t = await token("dave.testnet");
    const r = await post("/api/launch", { idea: await idea(t), listOn: "rhea", rhea: { openingFdvNear: 500 } }, t);
    expect(r.status).toBe(200);
    const j = LaunchResponse.parse(await r.json());
    expect(j.listing?.venue).toBe("rhea");
    expect(j.listing?.ok).toBe(true);
    expect(j.siteConfig.tokenLaunch.buyUrl).toContain("poolV2");
    const l = await (await app.request("/api/launches/dave.testnet")).json();
    expect(l.launches[0].venue).toBe("rhea");
  });

  test("nearly prepare builds launch calls with a site link and icon", async () => {
    const t = await token("erin.testnet");
    const ideas = [{ ...(await idea(t)), ticker: "nrly1" }];
    const res = await post("/api/nearly/prepare", { ideas }, t);
    const body = await res.json();
    if (res.status !== 200) console.log(body);
    const r = NearlyPrepareResponse.parse(body);
    expect(r.txs).toHaveLength(1);
    const a = (r.txs[0].args as any).args;
    expect(a.links.website).toBe(`https://yeetpad.fun/t/${r.txs[0].slug}`);
    expect(a.icon.startsWith("data:image/")).toBe(true);
    expect(a.symbol).toBe(ideas[0].ticker.toUpperCase());
    expect(r.chunk).toBe(10);
  });
});

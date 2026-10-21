import { beforeAll, describe, expect, test } from "bun:test";
import { LaunchIdea, LaunchResponse } from "@osl/schema";

let app: typeof import("./app").app;
beforeAll(async () => {
  process.env.LLM_MOCK = "1";
  process.env.NEAR_MOCK = "1";
  ({ app } = await import("./app"));
});

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("api (mock mode)", () => {
  test("generate returns a valid idea", async () => {
    const r = await post("/api/generate", { prompt: "a token for cat lovers", ownerWallet: "alice.testnet" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(LaunchIdea.safeParse(j.idea).success).toBe(true);
  });

  test("generate rejects bad input", async () => {
    const r = await post("/api/generate", { prompt: "", ownerWallet: "NOT VALID" });
    expect(r.status).toBe(400);
  });

  test("launch returns token + site config", async () => {
    const g = await (await post("/api/generate", { prompt: "rocket dogs", ownerWallet: "bob.testnet" })).json();
    const r = await post("/api/launch", { ownerWallet: "bob.testnet", idea: g.idea });
    expect(r.status).toBe(200);
    const j = LaunchResponse.parse(await r.json());
    expect(j.tokenId.startsWith(g.idea.ticker + ".")).toBe(true);
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

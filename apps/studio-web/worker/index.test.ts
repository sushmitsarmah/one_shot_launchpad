import { describe, expect, test } from "bun:test";
import worker from "./index";

const site = (o: object = {}) =>
  JSON.stringify({ slug: "moon-cat", branding: { name: "Moon Cat", ticker: "MOON", tagline: "t", description: "d" }, theme: { colors: { primary: "#111111", background: "#000000" } }, ...o });
function env(kv: Record<string, string>) {
  const puts: string[] = [];
  return {
    puts,
    env: {
      ASSETS: { fetch: async () => new Response("<html><head><title>x</title></head><body>page</body></html>", { headers: { "content-type": "text/html" } }) },
      SITES: { get: async (k: string) => kv[k] ?? null, put: async (k: string) => void puts.push(k) },
    },
  };
}
const ctx = { waitUntil: (p: Promise<unknown>) => void p };
const req = (path: string) => new Request(`https://yeetpad.fun${path}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/130", "sec-fetch-dest": "document" } });

describe("token page worker: taken-down sites", () => {
  test("taken-down site -> plain 410, no view counted", async () => {
    const e = env({ "slug:moon-cat": "moon", "site:moon": site({ takenDown: { at: 1, by: "a.testnet" } }) });
    const r = await worker.fetch(req("/t/moon-cat"), e.env as any, ctx);
    expect(r.status).toBe(410);
    const html = await r.text();
    expect(html).toContain("taken down by its creator");
    expect(html).not.toContain("Moon Cat");
    expect(e.puts.some((k) => k.startsWith("views:"))).toBe(false);
  });
  test("moderator takedown says so", async () => {
    const e = env({ "site:moon": site({ takenDown: { at: 1, by: "boss", byAdmin: true } }) });
    expect(await (await worker.fetch(req("/t/moon"), e.env as any, ctx)).text()).toContain("moderator");
  });
  test("chain-only token with a deleted:<ticker> record -> 410", async () => {
    const e = env({ "deleted:oldtk": JSON.stringify({ at: 1, by: "a" }) });
    expect((await worker.fetch(req("/t/oldtk"), e.env as any, ctx)).status).toBe(410);
  });
  test("live site still 200 and counts a view", async () => {
    const e = env({ "slug:moon-cat": "moon", "site:moon": site() });
    const r = await worker.fetch(req("/t/moon-cat"), e.env as any, ctx);
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 5));
    expect(e.puts).toContain("views:moon");
  });
});

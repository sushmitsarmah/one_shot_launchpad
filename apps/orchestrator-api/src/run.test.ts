import { describe, expect, test } from "bun:test";
import { MAX_BATCH, MAX_RUN, chunk, chunkSizes, clampRun, dedupeIdeas, generationCost, pool, type LaunchIdea } from "@osl/schema";

const idea = (name: string, ticker: string): LaunchIdea => ({
  name,
  ticker,
  tagline: "a tagline",
  description: "A description that is long enough.",
  colors: { primary: "#111111", secondary: "#222222", accent: "#333333", background: "#000000", text: "#ffffff" },
});

describe("run chunking", () => {
  test("constants", () => {
    expect(MAX_BATCH).toBe(5);
    expect(MAX_RUN).toBe(100);
  });
  test("clampRun clamps to 1..100", () => {
    expect(clampRun(0)).toBe(1);
    expect(clampRun(-4)).toBe(1);
    expect(clampRun("abc")).toBe(1);
    expect(clampRun(7.9)).toBe(7);
    expect(clampRun(100)).toBe(100);
    expect(clampRun(1000)).toBe(100);
  });
  test("chunk / chunkSizes", () => {
    expect(chunkSizes(12)).toEqual([5, 5, 2]);
    expect(chunkSizes(100).length).toBe(20);
    expect(chunkSizes(0)).toEqual([]);
    expect(chunk([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([[1, 2, 3, 4, 5], [6, 7]]);
    expect(chunk(Array.from({ length: 100 }, (_, i) => i), 10).every((c) => c.length === 10)).toBe(true);
    expect(() => chunk([1], 0)).toThrow();
  });
  test("generationCost", () => {
    expect(generationCost(100, 10n ** 22n)).toBe(10n ** 24n);
  });
  test("dedupeIdeas drops repeated names and renames clashing tickers across chunks", () => {
    const seen = { names: new Set<string>(), tickers: new Set<string>() };
    const a = dedupeIdeas([idea("Moon Cat", "mooncat"), idea("Sun Dog", "sundog")], seen);
    const b = dedupeIdeas([idea("moon cat", "other"), idea("Star Cat", "mooncat"), idea("Max Len", "abcdefghijklmnop")], seen);
    const c = dedupeIdeas([idea("Max Len Two", "abcdefghijklmnop")], seen);
    expect(a.map((i) => i.ticker)).toEqual(["mooncat", "sundog"]);
    expect(b.map((i) => i.ticker)).toEqual(["mooncat2", "abcdefghijklmnop"]);
    expect(c[0].ticker).toBe("abcdefghijklmno2");
    expect(c[0].ticker.length).toBeLessThanOrEqual(16);
  });
  test("pool: bounded concurrency, retries, failures don't stop the rest, order kept", async () => {
    let live = 0;
    let peak = 0;
    const tries = new Map<number, number>();
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      live++;
      peak = Math.max(peak, live);
      tries.set(i, (tries.get(i) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      if (i === 3 && tries.get(i)! < 2) throw new Error("flaky");
      if (i === 7) throw new Error("always");
      return i * 2;
    });
    const done: number[] = [];
    const r = await pool(tasks, { concurrency: 3, retries: 2, backoffMs: 1, onDone: (i) => done.push(i) });
    expect(peak).toBe(3);
    expect(r[3]).toEqual({ ok: true, value: 6 });
    expect(r[7]).toEqual({ ok: false, error: "always" });
    expect(tries.get(7)).toBe(3);
    expect(r.filter((x) => x.ok).length).toBe(9);
    expect(done.length).toBe(10);
  });
  test("pool: noRetry errors fail at once", async () => {
    let n = 0;
    const r = await pool([async () => { n++; throw Object.assign(new Error("402 short"), { noRetry: true }); }], { retries: 3, backoffMs: 1 });
    expect(n).toBe(1);
    expect(r[0].ok).toBe(false);
  });
});

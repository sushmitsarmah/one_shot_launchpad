import { describe, expect, test } from "bun:test";
import type { LaunchedToken, LaunchIdea } from "@osl/schema";
import { applyResults, mark, newRun, reconcile, runCounts } from "./run";

const idea = (ticker: string): LaunchIdea => ({
  name: `${ticker} coin`,
  ticker,
  tagline: "tag line",
  description: "A description that is long enough.",
  colors: { primary: "#111111", secondary: "#222222", accent: "#333333", background: "#000000", text: "#ffffff" },
});
const ok = (ticker: string) => ({ ticker, ok: true, tokenId: `${ticker}.f.testnet`, slug: `${ticker}-coin`, siteUrl: null, error: null });

describe("launch run state", () => {
  test("results, failures and counts across chunks", () => {
    let r = newRun("me.testnet", "none", ["a1", "b1", "c1", "d1", "e1", "f1", "g1"].map(idea));
    r = mark(r, ["a1", "b1", "c1", "d1", "e1"], "sending");
    r = applyResults(r, [ok("a1"), ok("b1"), { ...ok("c1"), ok: false, tokenId: null, error: "launch failed on-chain; that item was refunded" }, ok("d1"), ok("e1")], "TX1");
    expect(runCounts(r)).toEqual({ total: 7, done: 4, failed: 1, left: 2, listed: 0 });
    expect(r.items[0].txHash).toBe("TX1");
    r = applyResults(r, [{ ...ok("f1"), listing: { venue: "rhea", ok: true, tokenId: "f1.f.testnet", poolId: "p", lptId: null, url: "https://testnet.rhea.finance/poolV2/x", txHash: "L", error: null } }]);
    expect(r.items[5].status).toBe("listed");
    expect(r.items[5].listingUrl).toContain("rhea");
  });
  test("reconcile after reload: in-flight items found in My launches are done, others pending again", () => {
    let r = newRun("me.testnet", "none", ["a1", "b1", "c1"].map(idea));
    r = mark(r, ["a1", "b1"], "sending");
    const launches = [{ ticker: "a1", tokenId: "a1.f.testnet", slug: "a1-coin", createdAt: Date.now(), venue: "yeetpad" } as LaunchedToken];
    r = reconcile(r, launches);
    expect(r.items.map((i) => i.status)).toEqual(["ok", "pending", "pending"]);
    expect(r.items[0].slug).toBe("a1-coin");
  });
  test("reconcile ignores tokens older than the run (same ticker launched before)", () => {
    let r = newRun("me.testnet", "none", [idea("a1")]);
    r = reconcile(r, [{ ticker: "a1", tokenId: "a1.f", slug: null, createdAt: r.startedAt - 3_600_000 } as LaunchedToken]);
    expect(r.items[0].status).toBe("pending");
  });
});

describe("ideas draft (edits survive reload / redirect)", () => {
  test("save + load per account, clear on empty", async () => {
    const mem = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k) };
    const { loadDraft, saveDraft } = await import("./run");
    const orig = idea("a1");
    const edited = { ...orig, name: "Edited Name", description: "Edited description long enough." };
    saveDraft("me.testnet", { prompt: "p", ideas: [edited], originals: [orig], picked: [false] });
    const d = loadDraft("me.testnet")!;
    expect(d.ideas[0].name).toBe("Edited Name");
    expect(d.originals[0].name).toBe("a1 coin");
    expect(d.picked).toEqual([false]);
    expect(loadDraft("other.testnet")).toBeNull();
    saveDraft("me.testnet", { prompt: "", ideas: [], originals: [], picked: [] });
    expect(loadDraft("me.testnet")).toBeNull();
  });
});

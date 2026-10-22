import { describe, expect, test } from "bun:test";
import { classifyPull, fmtUnits, isSlippageError, minAmount, minsFor, quotePosition, removablePositions, removeLiquidityCall, slippageBps, UNPROTECTED } from "./dcl";

const T = "moon.ft-factory.x.testnet";
const pos = (id: string, pool: string, amount: string, o: object = {}) => ({ lpt_id: `${pool}#${id}`, owner_id: "me.testnet", pool_id: pool, amount, ...o });

describe("DCL liquidity withdrawal", () => {
  test("picks the creator's non-empty, unfarmed positions of that token's pools", () => {
    const all = [
      pos("1", `wrap.testnet|${T}|10000`, "100"),
      pos("2", `${T}|wrap.testnet|2000`, "5"),
      pos("3", `wrap.testnet|${T}|10000`, "0"),
      pos("4", `wrap.testnet|${T}|10000`, "9", { mft_id: ":1" }),
      pos("5", "wrap.testnet|other.testnet|10000", "100"),
      pos("6", `wrap.testnet|${T}|10000`, "7", { owner_id: "someone.testnet" }),
      pos("7", `wrap.testnet|x${T}|10000`, "7"),
    ];
    const r = removablePositions(all, T, "me.testnet");
    expect(r.removable.map((p) => p.lpt_id.split("#")[1])).toEqual(["1", "2"]);
    expect(r.farmed.length).toBe(1);
  });
  test("remove_liquidity call: full amount, no deposit, the given mins", () => {
    const p = pos("1", `wrap.testnet|${T}|10000`, "123");
    const c = removeLiquidityCall("dclv2.ref-dev.testnet", p, "moon", { x: 990n, y: 5n });
    expect(c).toMatchObject({ receiverId: "dclv2.ref-dev.testnet", methodName: "remove_liquidity", deposit: "0", ticker: "moon" });
    expect(c.args).toEqual({ lpt_id: `wrap.testnet|${T}|10000#1`, amount: "123", min_amount_x: "990", min_amount_y: "5" });
    expect(removeLiquidityCall("d", p, "moon", UNPROTECTED).args).toMatchObject({ min_amount_x: "0", min_amount_y: "0" });
  });
});

describe("slippage minimums", () => {
  test("slippage bounds: 0.01%..20%, presets map to bps", () => {
    expect(slippageBps(0.5)).toBe(50);
    expect(slippageBps(1)).toBe(100);
    expect(slippageBps(3)).toBe(300);
    expect(slippageBps(20)).toBe(2000);
    expect(slippageBps(0.01)).toBe(1);
    for (const bad of [0, -1, 0.001, 20.01, 50, NaN, Infinity]) expect(slippageBps(bad)).toBeNull();
    expect(() => minAmount(100n, 0)).toThrow();
    expect(() => minAmount(100n, 2001)).toThrow();
    expect(() => minAmount(100n, 1.5)).toThrow();
    expect(() => minAmount(-1n, 100)).toThrow();
  });
  test("expected × (1 − slippage), rounded down in base units", () => {
    expect(minAmount(10_000n, 100)).toBe(9_900n);
    expect(minAmount(1n, 100)).toBe(0n); // 0.99 -> 0
    expect(minAmount(199n, 50)).toBe(198n); // 198.005 -> 198
    expect(minAmount(101n, 100)).toBe(99n); // 99.99 -> 99, never rounds up
    expect(minAmount("999999999999999999999998951", 100)).toBe(989999999999999999999998961n); // live #2521 quote
    const big = 2n ** 128n - 1n; // u128 max: no precision loss
    expect(minAmount(big, 300)).toBe((big * 9700n) / 10000n);
    for (const e of [1n, 7n, 12345n, 10n ** 24n + 3n]) for (const b of [1, 50, 100, 300, 2000]) {
      const m = minAmount(e, b);
      expect(m <= e).toBe(true);
      expect(m * 10000n <= e * BigInt(10000 - b)).toBe(true);
      expect((m + 1n) * 10000n > e * BigInt(10000 - b)).toBe(true);
    }
  });
  test("zero liquidity side -> zero minimum; both sides", () => {
    expect(minAmount(0n, 100)).toBe(0n);
    expect(minsFor({ x: 0n, y: 5_000n }, 100)).toEqual({ x: 0n, y: 4_950n });
  });
  test("quote: uses predict_remove_liquidity for the full amount; failures never become zero", async () => {
    const p = pos("1", `wrap.testnet|${T}|10000`, "123");
    let seen: unknown;
    const ok = await quotePosition(async (c, m, a) => ((seen = { c, m, a }), ["10", "20"]), "dcl", p);
    expect(seen).toEqual({ c: "dcl", m: "predict_remove_liquidity", a: { lpt_id: p.lpt_id, amount: "123" } });
    expect(ok).toEqual({ ok: true, x: 10n, y: 20n });
    expect((await quotePosition(async () => { throw new Error("E207: liquidity not found"); }, "dcl", p)).ok).toBe(false);
    expect((await quotePosition(async () => null, "dcl", p)).ok).toBe(false);
    expect((await quotePosition(async () => ["1", "-2"], "dcl", p)).ok).toBe(false);
  });
  test("outcome classification and formatting", () => {
    const p = pos("1", `wrap.testnet|${T}|10000`, "123");
    expect(classifyPull(null, true, null)).toBe("withdrawn");
    expect(classifyPull({ ...p, amount: "0" }, true, null)).toBe("withdrawn");
    expect(classifyPull(p, true, '{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: E204: slippage error"}}}}')).toBe("slippage");
    expect(classifyPull(p, true, "Exceeded the prepaid gas")).toBe("failed");
    expect(classifyPull(p, false, "User rejected")).toBe("not-signed");
    expect(isSlippageError("E204: slippage error")).toBe(true);
    expect(fmtUnits(989999999999999999999998961n, 18)).toBe("989,999,999.9999");
    expect(fmtUnits(1_500_000_000_000_000_000_000_000n, 24)).toBe("1.5");
    expect(fmtUnits(0n, 24)).toBe("0");
    expect(fmtUnits(1n, 24)).toBe("<0.0001");
  });
});

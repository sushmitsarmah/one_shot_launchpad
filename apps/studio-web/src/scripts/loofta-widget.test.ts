import { describe, expect, test } from "bun:test";
import { parseUsd, safeLooftaUrl } from "./loofta-widget";
import { looftaToApply } from "../lib/run";

describe("loofta widget helpers", () => {
  test("amounts: $1..$10,000, 2 decimals", () => {
    expect(parseUsd("10")).toBe(10);
    expect(parseUsd("$2.50")).toBe(2.5);
    expect(parseUsd("0.99")).toBeNull();
    expect(parseUsd("10001")).toBeNull();
    expect(parseUsd("1.234")).toBeNull();
    expect(parseUsd("1e3")).toBeNull();
    expect(parseUsd("")).toBeNull();
  });
  test("only Loofta pay URLs are opened", () => {
    expect(safeLooftaUrl("https://pay.loofta.com/checkout/abc")).toBe("https://pay.loofta.com/checkout/abc");
    expect(safeLooftaUrl("https://pay.loofta.xyz/checkout/k1?callback=https%3A%2F%2Fyeetpad.fun")).toBe("https://pay.loofta.xyz/checkout/k1?callback=https%3A%2F%2Fyeetpad.fun");
    expect(safeLooftaUrl("https://pay.loofta.com.evil.io/x")).toBeNull();
    expect(safeLooftaUrl("https://x@pay.loofta.xyz/checkout/k1")).toBeNull();
    expect(safeLooftaUrl("http://pay.loofta.xyz/checkout/k1")).toBeNull();
    expect(safeLooftaUrl("javascript:alert(1)")).toBeNull();
    expect(safeLooftaUrl(null)).toBeNull();
  });
  test("pending Loofta toggles apply to launched, own, not-yet-enabled tokens", () => {
    const launches = [
      { ticker: "a", ownerId: "me.testnet" },
      { ticker: "b", ownerId: "me.testnet", loofta: { enabled: true } },
      { ticker: "c", ownerId: "other.testnet" },
      { ticker: "d", ownerId: "me.testnet", deletedAt: 1 },
    ];
    expect(looftaToApply(["a", "b", "c", "d", "zz"], launches, "me.testnet")).toEqual(["a"]);
  });
});

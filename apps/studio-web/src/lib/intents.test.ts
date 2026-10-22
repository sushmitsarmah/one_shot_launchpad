import { describe, expect, test } from "bun:test";
import { formatUnits, isMainnetAccount, minOut, parseUnits, payOptions, rheaBuyCalls } from "./intents";

describe("intents widget helpers", () => {
  test("parseUnits / formatUnits with BigInt", () => {
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseUnits("0.00000001", 8)).toBe(1n);
    expect(parseUnits("0.000000001", 8)).toBeNull();
    expect(parseUnits("0", 6)).toBeNull();
    expect(parseUnits("-1", 6)).toBeNull();
    expect(parseUnits("1e5", 6)).toBeNull();
    expect(parseUnits(".5", 2)).toBe(50n);
    expect(parseUnits("123456789.123456789123456789", 24)).toBe(123456789123456789123456789000000n);
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatUnits(2090584364488963619054877n, 24, 4)).toBe("2.0905");
  });
  test("mainnet accounts only", () => {
    for (const ok of ["alice.near", "a1.tg", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]) expect(isMainnetAccount(ok)).toBe(true);
    for (const bad of ["alice.testnet", "A.near", "x", "bad..near", ""]) expect(isMainnetAccount(bad)).toBe(false);
  });
  test("pay options: popular first, labelled by chain", () => {
    const o = payOptions([
      { assetId: "a", symbol: "ZEC", blockchain: "zec", decimals: 8 },
      { assetId: "b", symbol: "USDC", blockchain: "base", decimals: 6 },
      { assetId: "b", symbol: "USDC", blockchain: "base", decimals: 6 },
      { assetId: "c", symbol: "BTC", blockchain: "btc", decimals: 8 },
    ]);
    expect(o.map((x) => x.label)).toEqual(["USDC · Base", "BTC · Bitcoin", "ZEC · Zcash"]);
  });
  test("Rhea buy calls: optional registrations + wrap, then the DCL Swap", () => {
    const calls = rheaBuyCalls({ dcl: "dcl", wnear: "wrap.near", poolId: "p|wrap.near|10000", token: "p", amountIn: 10n, minAmountOut: minOut(1000n, 100), wrapNear: 4n, registerToken: true, registerWnear: false });
    expect(calls.map((c) => `${c.receiverId}.${c.methodName}`)).toEqual(["p.storage_deposit", "wrap.near.near_deposit", "wrap.near.ft_transfer_call"]);
    expect(calls[1].deposit).toBe("4");
    const swap = calls[2];
    expect(swap.deposit).toBe("1");
    expect(swap.args.receiver_id).toBe("dcl");
    expect(JSON.parse(swap.args.msg as string)).toEqual({ Swap: { pool_ids: ["p|wrap.near|10000"], output_token: "p", min_output_amount: "990" } });
    expect(rheaBuyCalls({ dcl: "d", wnear: "w", poolId: "x", token: "t", amountIn: 1n, minAmountOut: 1n, wrapNear: 0n, registerToken: false, registerWnear: false }).length).toBe(1);
  });
});

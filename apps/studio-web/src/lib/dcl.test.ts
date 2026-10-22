import { describe, expect, test } from "bun:test";
import { removablePositions, removeLiquidityCall } from "./dcl";

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
  test("remove_liquidity call: full amount, no deposit, zero mins", () => {
    const c = removeLiquidityCall("dclv2.ref-dev.testnet", pos("1", `wrap.testnet|${T}|10000`, "123"), "moon");
    expect(c).toMatchObject({ receiverId: "dclv2.ref-dev.testnet", methodName: "remove_liquidity", deposit: "0", ticker: "moon" });
    expect(c.args).toEqual({ lpt_id: `wrap.testnet|${T}|10000#1`, amount: "123", min_amount_x: "0", min_amount_y: "0" });
  });
});

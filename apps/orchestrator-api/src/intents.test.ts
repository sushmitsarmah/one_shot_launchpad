import { describe, expect, test } from "bun:test";
import { planQuote, shapeQuote, USDC_NEAR_ASSET, WNEAR_ASSET } from "./intents";

const req = (o: object = {}) => ({ site: "moon", mode: "tip" as const, originAsset: "nep141:sol.omft.near", amount: "100", ...o });
const cfg = (o: object = {}) => ({ enabled: true, mode: "both" as const, tipAsset: "usdc" as const, ...o });

describe("1Click quote plan", () => {
  test("off / wrong mode refused", () => {
    expect(planQuote(req(), null, "c.near", true)).toMatchObject({ ok: false, status: 403 });
    expect(planQuote(req(), cfg({ enabled: false }), "c.near", true)).toMatchObject({ ok: false, status: 403 });
    expect(planQuote(req({ mode: "buy" }), cfg({ mode: "tip" }), "c.near", true)).toMatchObject({ ok: false, status: 403 });
  });
  test("mainnet tip: real quote to the creator (or set recipient), refund on origin chain, no app fees", () => {
    const p = planQuote(req({ refundTo: "So1Refund" }), cfg(), "creator.near", true, 0);
    expect(p.ok && p.body).toMatchObject({ dry: false, destinationAsset: USDC_NEAR_ASSET, recipient: "creator.near", refundTo: "So1Refund", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", depositType: "ORIGIN_CHAIN", swapType: "EXACT_INPUT" });
    expect(p.ok && "appFees" in p.body).toBe(false);
    expect(p.ok && p.body.deadline).toBe(new Date(3 * 3600_000).toISOString());
    const w = planQuote(req({ refundTo: "x12" }), cfg({ tipAsset: "wnear", recipient: "tips.near" }), "creator.near", true);
    expect(w.ok && w.body).toMatchObject({ destinationAsset: WNEAR_ASSET, recipient: "tips.near" });
    // the visitor can't redirect a tip
    const r = planQuote(req({ refundTo: "x12", recipient: "attacker.near" }), cfg(), "creator.near", true);
    expect(r.ok && r.body.recipient).toBe("creator.near");
  });
  test("mainnet buy: wNEAR to the visitor; real quotes need refund + recipient", () => {
    expect(planQuote(req({ mode: "buy", refundTo: "x12" }), cfg(), "c.near", true)).toMatchObject({ ok: false, status: 400 });
    expect(planQuote(req({ mode: "buy", recipient: "v.near" }), cfg(), "c.near", true)).toMatchObject({ ok: false, status: 400 });
    expect(planQuote(req({ mode: "buy", recipient: "v.testnet", refundTo: "x12" }), cfg(), "c.near", true)).toMatchObject({ ok: false, status: 400 });
    const p = planQuote(req({ mode: "buy", recipient: "v.near", refundTo: "x12" }), cfg(), "c.near", true);
    expect(p.ok && p.body).toMatchObject({ dry: false, destinationAsset: WNEAR_ASSET, recipient: "v.near" });
    const d = planQuote(req({ mode: "buy", dry: true }), cfg(), "c.near", true);
    expect(d.ok && d.body).toMatchObject({ dry: true, recipient: "intents.near", refundType: "INTENTS" });
  });
  test("testnet: always dry with placeholder accounts", () => {
    const p = planQuote(req({ refundTo: "x12", dry: false }), cfg(), "c.testnet", false);
    expect(p).toMatchObject({ ok: true, dry: true, preview: true });
    expect(p.ok && p.body.recipient).toBe("intents.near");
  });
  test("deposit address only from a non-dry 1Click answer", () => {
    const j = { quote: { amountIn: "1", amountOut: "2", depositAddress: "addr1234567890" }, quoteRequest: { destinationAsset: WNEAR_ASSET } };
    expect(shapeQuote(j, true, false).depositAddress).toBeNull();
    expect(shapeQuote(j, false, false).depositAddress).toBe("addr1234567890");
    expect(() => shapeQuote({ quote: {} }, false, false)).toThrow();
  });
});

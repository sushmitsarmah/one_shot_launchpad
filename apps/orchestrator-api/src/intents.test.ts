import { describe, expect, test } from "bun:test";
import { isNearMainnetAccount } from "@osl/schema";
import { intentsForPage, intentsPageState, planQuote, shapeQuote, tipRecipient, TIP_NO_RECIPIENT_NOTE, USDC_NEAR_ASSET, WNEAR_ASSET } from "./intents";

const req = (o: object = {}) => ({ site: "moon", mode: "tip" as const, originAsset: "nep141:sol.omft.near", amount: "100", ...o });
const cfg = (o: object = {}) => ({ enabled: true, mode: "both" as const, tipAsset: "usdc" as const, ...o });

describe("1Click quote plan (always mainnet)", () => {
  test("off / wrong mode refused", () => {
    expect(planQuote(req(), null, "c.near")).toMatchObject({ ok: false, status: 403 });
    expect(planQuote(req(), cfg({ enabled: false }), "c.near")).toMatchObject({ ok: false, status: 403 });
    expect(planQuote(req({ mode: "buy" }), cfg({ mode: "tip" }), "c.near")).toMatchObject({ ok: false, status: 403 });
  });
  test("tip: real quote to the resolved recipient, refund on origin chain, no app fees", () => {
    const p = planQuote(req({ refundTo: "So1Refund" }), cfg(), "creator.near", 0);
    expect(p).toMatchObject({ ok: true, dry: false, preview: false });
    expect(p.ok && p.body).toMatchObject({ dry: false, destinationAsset: USDC_NEAR_ASSET, recipient: "creator.near", refundTo: "So1Refund", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", depositType: "ORIGIN_CHAIN", swapType: "EXACT_INPUT" });
    expect(p.ok && "appFees" in p.body).toBe(false);
    expect(p.ok && p.body.deadline).toBe(new Date(3 * 3600_000).toISOString());
    const w = planQuote(req({ refundTo: "x12" }), cfg({ tipAsset: "wnear" }), "tips.near");
    expect(w.ok && w.body).toMatchObject({ destinationAsset: WNEAR_ASSET, recipient: "tips.near" });
    // the visitor can't redirect a tip
    const r = planQuote(req({ refundTo: "x12", recipient: "attacker.near" }), cfg(), "creator.near");
    expect(r.ok && r.body.recipient).toBe("creator.near");
  });
  test("tip on a testnet deployment: real (non-dry) mainnet quote when a mainnet recipient exists; never to a testnet name", () => {
    const p = planQuote(req({ refundTo: "x12" }), cfg(), "sillypuma1184.near");
    expect(p).toMatchObject({ ok: true, dry: false });
    expect(p.ok && p.body.recipient).toBe("sillypuma1184.near");
    expect(planQuote(req({ refundTo: "x12" }), cfg(), null)).toMatchObject({ ok: false, status: 409 });
    expect(planQuote(req({ refundTo: "x12" }), cfg(), "creator.testnet")).toMatchObject({ ok: false, status: 409 });
    expect(planQuote(req({ dry: true }), cfg(), "creator.testnet")).toMatchObject({ ok: false, status: 409 });
  });
  test("buy: wNEAR to the visitor on mainnet; real quotes need refund + recipient; same on every deployment", () => {
    expect(planQuote(req({ mode: "buy", refundTo: "x12" }), cfg(), "c.near")).toMatchObject({ ok: false, status: 400 });
    expect(planQuote(req({ mode: "buy", recipient: "v.near" }), cfg(), "c.near")).toMatchObject({ ok: false, status: 400 });
    expect(planQuote(req({ mode: "buy", recipient: "v.testnet", refundTo: "x12" }), cfg(), "c.near")).toMatchObject({ ok: false, status: 400 });
    const p = planQuote(req({ mode: "buy", recipient: "v.near", refundTo: "x12" }), cfg(), "c.near");
    expect(p.ok && p.body).toMatchObject({ dry: false, destinationAsset: WNEAR_ASSET, recipient: "v.near" });
    const d = planQuote(req({ mode: "buy", dry: true }), cfg(), "c.near");
    expect(d.ok && d.body).toMatchObject({ dry: true, recipient: "intents.near", refundType: "INTENTS" });
    // no network gating for buy: a testnet deployment gets the same mainnet quote
    expect(planQuote(req({ mode: "buy", dry: true }), cfg(), null)).toMatchObject({ ok: true, dry: true });
  });
});

describe("tip recipient and page state", () => {
  test("mainnet accounts only", () => {
    for (const a of ["sillypuma1184.near", "a.b-c.near", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "0x0123456789abcdef0123456789abcdef01234567", "a1.tg"]) expect(isNearMainnetAccount(a)).toBe(true);
    for (const a of ["x.testnet", "near", "foo", "Bad.near", "a..near", "0x123", "osl-e2e-mvhxupmb.testnet", "x.betanet", "", "-a.near"]) expect(isNearMainnetAccount(a)).toBe(false);
  });
  test("page recipient > creator payout > creator (mainnet deployments only)", () => {
    expect(tipRecipient(cfg({ recipient: "page.near" }), "c.near", "pay.near", true)).toBe("page.near");
    expect(tipRecipient(cfg(), "c.near", "pay.near", true)).toBe("pay.near");
    expect(tipRecipient(cfg(), "c.near", null, true)).toBe("c.near");
    expect(tipRecipient(cfg(), "c.near", null, false)).toBeNull(); // testnet deployment: owner isn't used
    expect(tipRecipient(cfg(), "c.testnet", null, true)).toBeNull();
    expect(tipRecipient(cfg({ recipient: "old.testnet" }), "c.testnet", "pay.near", false)).toBe("pay.near");
  });
  test("testnet deployment: buy stays; tip only with a mainnet recipient; a note explains", () => {
    expect(intentsForPage(cfg(), "c.testnet", null, false)).toEqual({ enabled: true, mode: "buy", tipAsset: "usdc" });
    expect(intentsPageState(cfg(), "c.testnet", null, false)).toEqual({ tip: false, buy: true, recipient: null, notes: [TIP_NO_RECIPIENT_NOTE] });
    expect(intentsForPage(cfg({ mode: "tip" }), "c.testnet", null, false)).toBeNull();
    expect(intentsForPage(cfg(), "c.testnet", "sillypuma1184.near", false)).toEqual({ enabled: true, mode: "both", tipAsset: "usdc", recipient: "sillypuma1184.near" });
    expect(intentsForPage(cfg({ mode: "buy" }), "c.testnet", null, false)).toEqual({ enabled: true, mode: "buy", tipAsset: "usdc" });
    expect(intentsForPage(cfg(), "c.near", null, true)).toEqual({ enabled: true, mode: "both", tipAsset: "usdc", recipient: "c.near" });
    expect(intentsForPage(cfg({ mode: "buy" }), "c.near", null, true)).toEqual({ enabled: true, mode: "buy", tipAsset: "usdc" });
    expect(intentsForPage(cfg({ enabled: false }), "c.near", null, true)).toBeNull();
  });
  test("deposit address only from a non-dry 1Click answer", () => {
    const j = { quote: { amountIn: "1", amountOut: "2", depositAddress: "addr1234567890" }, quoteRequest: { destinationAsset: WNEAR_ASSET } };
    expect(shapeQuote(j, true, false).depositAddress).toBeNull();
    expect(shapeQuote(j, false, false).depositAddress).toBe("addr1234567890");
    expect(() => shapeQuote({ quote: {} }, false, false)).toThrow();
  });
});

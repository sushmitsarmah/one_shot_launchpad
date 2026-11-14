import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BUYERS, MIN_DEPOSIT, SELLERS, TOKEN_STORAGE, clearLot, commitHash, simulateOffline } from "./engine";

describe("swarm engine (mirrors contracts/swarm-market)", () => {
  test("commit hash format matches the contract", () => {
    // Same preimage as the contract test commit_hash_matches_known_vector.
    const want = createHash("sha256").update("3:1:buyer-7.yeetpad-swarm.testnet:120:25000000000000000000:abc").digest("hex");
    expect(commitHash(3, 1, "buyer-7.yeetpad-swarm.testnet", 120n, 25_000_000_000_000_000_000n, "abc")).toBe(want);
  });

  test("clearLot: same vectors as the contract test r5_clear_lot_uniform_price_partial_fill_and_ties", () => {
    const bids = [
      { i: 0, qty: 60n, price: 5n },
      { i: 1, qty: 30n, price: 7n },
      { i: 2, qty: 30n, price: 5n },
      { i: 3, qty: 50n, price: 3n },
    ];
    expect(clearLot(100n, bids)).toEqual({ fills: [{ i: 1, filled: 30n }, { i: 0, filled: 60n }, { i: 2, filled: 10n }], clearing: 5n });
    const all = clearLot(1000n, bids);
    expect(all.fills.length).toBe(4);
    expect(all.clearing).toBe(3n);
    expect(clearLot(10n, [])).toEqual({ fills: [], clearing: 0n });
  });

  test("20 buyers, 5 sellers, offline rounds conserve NEAR and respect every rule", () => {
    expect(BUYERS.length).toBe(20);
    expect(SELLERS.length).toBe(5);
    const rounds = simulateOffline(5, "test-seed");
    expect(rounds.length).toBe(5);
    let anySale = false;
    for (const r of rounds) {
      const dep = r.bids.reduce((s, b) => s + b.deposit, 0n);
      const out = r.bids.reduce((s, b) => s + b.refund + b.fee, 0n) + r.lots.reduce((s, l) => s + l.proceeds + l.penalties, 0n);
      expect(out).toBe(dep);
      for (const b of r.bids) {
        expect(b.deposit >= MIN_DEPOSIT).toBe(true);
        if (b.outcome === "Won") {
          const lot = r.lots[b.lot];
          expect(lot.clearing <= b.price).toBe(true); // nobody pays more than its bid
          expect(b.paid).toBe(b.filled * lot.clearing);
          expect(b.fee).toBe(TOKEN_STORAGE);
          anySale = true;
        }
      }
      for (const l of r.lots) expect(l.sold <= l.quantity).toBe(true);
      // at most one commit per (buyer, lot)
      const keys = r.bids.map((b) => `${b.bidder}/${b.lot}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(anySale).toBe(true);
  });

  test("deterministic for a seed", () => {
    const a = simulateOffline(2, "s").map((r) => r.lots.map((l) => [l.sold, l.clearing]));
    const b = simulateOffline(2, "s").map((r) => r.lots.map((l) => [l.sold, l.clearing]));
    expect(a).toEqual(b);
  });
});

// Yeetpad Swarm Market: the market rules in TypeScript (mirrors contracts/swarm-market and RULES.md) plus
// the scripted agent strategies. No LLM anywhere: every decision is a seeded, deterministic function.
// Used by scripts/swarm-sim.ts for both the offline simulation and the on-chain run.
import { createHash, randomBytes } from "node:crypto";

export const NEAR = 10n ** 24n;
export const MILLI = NEAR / 1000n;
export const UNIT = 10n ** 18n; // Yeetpad tokens have 18 decimals
export const MIN_DEPOSIT = 5n * MILLI;
export const TOKEN_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
export const NO_REVEAL_PENALTY_BPS = 1000n;
/** yoctoNEAR per whole token. 1e19 = 0.00001 NEAR. */
export const P = 10n ** 19n;

// ---------- rules (R4/R5/R6) ----------

/** R4: hex(sha256("{round}:{lot}:{bidder}:{qty}:{price}:{salt}")) */
export function commitHash(round: number, lot: number, bidder: string, qty: bigint, price: bigint, salt: string): string {
  return createHash("sha256").update(`${round}:${lot}:${bidder}:${qty}:${price}:${salt}`).digest("hex");
}
export const newSalt = () => randomBytes(16).toString("hex");

/** R5.1–R5.4. `bids` = eligible (index, qty, price) in commit order. Same as the contract's clear_lot. */
export function clearLot(quantity: bigint, bids: { i: number; qty: bigint; price: bigint }[]) {
  const order = [...bids].sort((a, b) => (a.price === b.price ? a.i - b.i : a.price > b.price ? -1 : 1));
  let left = quantity;
  let clearing = 0n;
  const fills: { i: number; filled: bigint }[] = [];
  for (const b of order) {
    if (left === 0n) break;
    const f = b.qty < left ? b.qty : left;
    if (f === 0n) continue;
    left -= f;
    fills.push({ i: b.i, filled: f });
    clearing = b.price;
  }
  return { fills, clearing };
}

export type Lot = { seller: string; token: string; quantity: bigint; reserve: bigint; sold: bigint; clearing: bigint; proceeds: bigint; penalties: bigint; status: "Open" | "Cleared" | "NoSale" };
export type Bid = {
  bidder: string; lot: number; hash: string; deposit: bigint; qty: bigint; price: bigint; revealed: boolean;
  outcome: "Pending" | "Won" | "Lost" | "Invalid" | "Unrevealed"; filled: bigint; paid: bigint; fee: bigint; refund: bigint;
};

/** R4.5 + R5 + R6.1–R6.2 for a whole round, in place. Same result as the contract's `clear`. */
export function clearRound(lots: Lot[], bids: Bid[]) {
  bids.forEach((b) => {
    if (b.revealed && (b.qty === 0n || b.qty * b.price + TOKEN_STORAGE > b.deposit)) b.outcome = "Invalid";
  });
  lots.forEach((l, li) => {
    const eligible = bids
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.lot === li && b.revealed && b.outcome !== "Invalid" && b.price >= l.reserve)
      .map(({ b, i }) => ({ i, qty: b.qty, price: b.price }));
    const { fills, clearing } = clearLot(l.quantity, eligible);
    l.sold = 0n; l.proceeds = 0n; l.penalties = 0n;
    for (const { i, filled } of fills) {
      const b = bids[i];
      b.filled = filled; b.outcome = "Won"; b.paid = filled * clearing; b.fee = TOKEN_STORAGE;
      l.sold += filled; l.proceeds += b.paid;
    }
    for (const b of bids.filter((x) => x.lot === li)) {
      if (b.outcome === "Won") b.refund = b.deposit - b.paid - b.fee;
      else if (b.outcome === "Invalid") b.refund = b.deposit;
      else if (!b.revealed) {
        const pen = (b.deposit * NO_REVEAL_PENALTY_BPS) / 10000n;
        l.penalties += pen; b.outcome = "Unrevealed"; b.refund = b.deposit - pen;
      } else { b.outcome = "Lost"; b.refund = b.deposit; }
    }
    l.clearing = l.sold > 0n ? clearing : 0n;
    l.status = l.sold > 0n ? "Cleared" : "NoSale";
  });
}

// ---------- seeded randomness ----------

/** mulberry32 seeded from a string: deterministic per (seed, agent, round). */
export function rng(...parts: (string | number)[]) {
  let h = 1779033703;
  for (const c of parts.join("|")) h = Math.imul(h ^ c.charCodeAt(0), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
/** price as bigint yocto from a float multiple of P (0.00001 NEAR), rounded to 1e15 yocto. */
const price = (x: number) => (BigInt(Math.max(1, Math.round(x * 10000))) * P) / 10000n;

// ---------- agents ----------

export type SellerStrategy = "anchor" | "adaptive" | "premium" | "dumper" | "scarcity";
export type BuyerStrategy = "truthful" | "shader" | "bargain" | "momentum" | "whale" | "flake" | "splitter";

export const SELLERS: { name: string; ticker: string; title: string; strategy: SellerStrategy; blurb: string }[] = [
  { name: "seller-1", ticker: "swarmpaw", title: "Swarm Paw", strategy: "anchor", blurb: "Fixed reserve, fixed 1,000-token lots." },
  { name: "seller-2", ticker: "swarmzap", title: "Swarm Zap", strategy: "adaptive", blurb: "Sets its reserve to 90% of its last clearing price." },
  { name: "seller-3", ticker: "swarmmoon", title: "Swarm Moon", strategy: "premium", blurb: "High reserve, small 600-token lots." },
  { name: "seller-4", ticker: "swarmfrog", title: "Swarm Frog", strategy: "dumper", blurb: "Low reserve, big 2,000-token lots." },
  { name: "seller-5", ticker: "swarmbyte", title: "Swarm Byte", strategy: "scarcity", blurb: "Shrinks lots 20% after a sell-out, grows them 20% after unsold stock." },
];

const BUYER_PLAN: BuyerStrategy[] = [
  "truthful", "truthful", "truthful", "shader", "shader", "shader", "bargain", "bargain", "bargain",
  "momentum", "momentum", "momentum", "whale", "whale", "flake", "flake", "splitter", "splitter", "splitter", "shader",
];
export const BUYER_BLURB: Record<BuyerStrategy, string> = {
  truthful: "Bids its true value (uniform price makes that close to optimal).",
  shader: "Shades its bid to 80% of its value.",
  bargain: "Bids just above the reserve on the cheapest-looking lot.",
  momentum: "Bids the lot's last clearing price +10%, capped at its value.",
  whale: "Wants big quantities at a moderate price.",
  flake: "Bids its value, but 35% of the time never reveals (and pays the 10% penalty).",
  splitter: "Splits its demand over its two favourite lots.",
};
export const BUYERS = BUYER_PLAN.map((strategy, i) => ({ name: `buyer-${i + 1}`, strategy }));

/** Each buyer's private value per whole token for each seller's token (in units of P), fixed for the run. */
export function valuations(seed: string, buyer: string): number[] {
  const r = rng(seed, buyer, "value");
  const base = between(r, 1.0, 4.0);
  return SELLERS.map(() => base * between(r, 0.6, 1.4));
}

export type History = { seller: string; clearing: bigint; sold: bigint; quantity: bigint; reserve: bigint }[][]; // per round, per lot

function lastFor(history: History, seller: string) {
  for (let i = history.length - 1; i >= 0; i--) {
    const l = history[i].find((x) => x.seller === seller);
    if (l) return l;
  }
  return undefined;
}

/** R3: a seller's lot for the next round: whole tokens and reserve (yocto per token). */
export function sellerLot(strategy: SellerStrategy, seller: string, history: History): { quantity: bigint; reserve: bigint } {
  const last = lastFor(history, seller);
  switch (strategy) {
    case "anchor":
      return { quantity: 1000n, reserve: P };
    case "adaptive": {
      const r = last && last.clearing > 0n ? (last.clearing * 9n) / 10n : P;
      return { quantity: 1000n, reserve: r < P / 2n ? P / 2n : r };
    }
    case "premium":
      return { quantity: 600n, reserve: (P * 5n) / 2n };
    case "dumper":
      return { quantity: 2000n, reserve: P / 2n };
    case "scarcity": {
      let q = last?.quantity ?? 1000n;
      if (last) q = last.sold >= last.quantity ? (q * 8n) / 10n : (q * 12n) / 10n;
      if (q < 200n) q = 200n;
      if (q > 3000n) q = 3000n;
      return { quantity: q, reserve: (P * 6n) / 5n };
    }
  }
}

export type LotView = { lot: number; seller: string; quantity: bigint; reserve: bigint };
export type BidPlan = { lot: number; qty: bigint; price: bigint; deposit: bigint; salt: string; willReveal: boolean };

/** R4.3: every buyer escrows its full round budget, never the bid amount. */
export const BUYER_BUDGET = 30n * MILLI;
export const WHALE_BUDGET = 50n * MILLI;

/** A buyer's sealed bids for this round (0–2 of them), from its strategy, values and public history. */
export function buyerBids(seed: string, buyer: { name: string; strategy: BuyerStrategy }, round: number, lots: LotView[], history: History): BidPlan[] {
  const r = rng(seed, buyer.name, round);
  const vals = valuations(seed, buyer.name);
  const sellerIdx = (s: string) => SELLERS.findIndex((x) => s.startsWith(`${x.name}.`) || s === x.name);
  const scored = lots
    .map((l) => {
      const v = vals[Math.max(0, sellerIdx(l.seller))] ?? 2;
      const last = lastFor(history, l.seller);
      const expect = Math.max(Number(l.reserve) / Number(P), last && last.clearing > 0n ? Number(last.clearing) / Number(P) : 0);
      return { l, v, expect, surplus: v - expect + between(r, -0.3, 0.3) };
    })
    .filter((x) => x.v * 1.0 > Number(x.l.reserve) / Number(P))
    .sort((a, b) => b.surplus - a.surplus);
  if (!scored.length) return [];
  const budget = buyer.strategy === "whale" ? WHALE_BUDGET : BUYER_BUDGET;
  const plans: BidPlan[] = [];
  const want = buyer.strategy === "whale" ? between(r, 400, 900) : between(r, 50, 320);
  const reserveOf = (l: LotView) => Number(l.reserve) / Number(P);
  const make = (pick: (typeof scored)[number], qtyF: number, pr: number, share = 1) => {
    let p = price(Math.max(pr, reserveOf(pick.l) * 1.0001));
    // keep qty × price + fee within the per-bid share of the budget (R4.5)
    const cap = (budget * BigInt(Math.round(share * 1000))) / 1000n;
    let qty = BigInt(Math.max(1, Math.round(qtyF)));
    const maxQty = (cap - TOKEN_STORAGE) / p;
    if (qty > maxQty) qty = maxQty;
    if (qty < 1n) return;
    plans.push({ lot: pick.l.lot, qty, price: p, deposit: cap, salt: newSalt(), willReveal: true });
  };
  const best = scored[0];
  switch (buyer.strategy) {
    case "truthful":
      make(best, want, best.v);
      break;
    case "shader":
      make(best, want, best.v * 0.8);
      break;
    case "bargain": {
      const cheap = [...scored].sort((a, b) => a.expect - b.expect)[0];
      make(cheap, want, reserveOf(cheap.l) * between(r, 1.01, 1.12));
      break;
    }
    case "momentum": {
      const last = lastFor(history, best.l.seller);
      const target = last && last.clearing > 0n ? (Number(last.clearing) / Number(P)) * 1.1 : best.v * 0.9;
      make(best, want, Math.min(best.v, target));
      break;
    }
    case "whale":
      make(best, want, best.v * 0.7);
      break;
    case "flake":
      make(best, want, best.v);
      if (plans[0]) plans[0].willReveal = r() > 0.35;
      break;
    case "splitter":
      make(best, want / 2, best.v * 0.9, 0.5);
      if (scored[1]) make(scored[1], want / 2, scored[1].v * 0.9, 0.5);
      break;
  }
  for (const p of plans) if (p.deposit < MIN_DEPOSIT) p.deposit = MIN_DEPOSIT;
  return plans;
}

// ---------- offline simulation (no chain, no LLM) ----------

export type SimRound = { round: number; lots: Lot[]; bids: Bid[] };

export function simulateOffline(rounds: number, seed = "yeetpad"): SimRound[] {
  const out: SimRound[] = [];
  const history: History = [];
  for (let round = 0; round < rounds; round++) {
    const lots: Lot[] = SELLERS.map((s) => {
      const { quantity, reserve } = sellerLot(s.strategy, s.name, history);
      return { seller: s.name, token: s.ticker, quantity, reserve, sold: 0n, clearing: 0n, proceeds: 0n, penalties: 0n, status: "Open" };
    });
    const views: LotView[] = lots.map((l, lot) => ({ lot, seller: l.seller, quantity: l.quantity, reserve: l.reserve }));
    const bids: Bid[] = [];
    for (const b of BUYERS) {
      for (const p of buyerBids(seed, b, round, views, history)) {
        bids.push({
          bidder: b.name, lot: p.lot, hash: commitHash(round, p.lot, b.name, p.qty, p.price, p.salt), deposit: p.deposit,
          qty: p.willReveal ? p.qty : 0n, price: p.willReveal ? p.price : 0n, revealed: p.willReveal,
          outcome: "Pending", filled: 0n, paid: 0n, fee: 0n, refund: 0n,
        });
      }
    }
    clearRound(lots, bids);
    history.push(lots.map((l) => ({ seller: l.seller, clearing: l.clearing, sold: l.sold, quantity: l.quantity, reserve: l.reserve })));
    out.push({ round, lots, bids });
  }
  return out;
}

export const fmtNear = (y: bigint, dp = 5) => {
  const neg = y < 0n;
  const a = neg ? -y : y;
  const s = `${a / NEAR}.${(a % NEAR).toString().padStart(24, "0").slice(0, dp)}`;
  return neg ? `-${s}` : s;
};
/** price per token in NEAR (e.g. 0.0000231) */
export const fmtPrice = (y: bigint) => (Number(y) / 1e24).toFixed(7);

// Yeetpad Swarm Market simulation: 20 buyer agents and 5 seller agents trade Yeetpad tokens in sealed-bid
// rounds on the swarm-market contract. Scripted strategies only (scripts/swarm/engine.ts), no LLM calls.
//
//   bun run swarm -- --offline [--rounds 5] [--seed yeetpad]   in-memory market, no chain, no keys
//   bun run swarm -- setup                                     create agent sub-accounts, deploy market, launch tokens
//   bun run swarm -- [--rounds 3]                              run N full rounds on testnet (runs setup first if needed)
//   bun run swarm -- status                                    print the latest rounds from chain
//
// Keys: parent ~/.secrets/near_yeetpad-swarm.testnet.json, agents ~/.secrets/swarm-agents.json (both chmod 600,
// never printed). Testnet only.
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  BUYERS, SELLERS, UNIT, buyerBids, commitHash, fmtNear, fmtPrice, sellerLot, simulateOffline,
  type BidPlan, type History, type LotView, type SimRound,
} from "./swarm/engine";

const args = process.argv.slice(2);
const flag = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ROUNDS = Number(flag("rounds", "3"));
const SEED = flag("seed", "yeetpad");
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && args[i - 1] !== "--offline"));
const cmd = args.includes("--offline") ? "offline" : (positional[0] ?? "run");

// ---------- offline ----------

function printRound(r: SimRound, label = (s: string) => s) {
  console.log(`\n=== round ${r.round} ===`);
  r.lots.forEach((l, i) => {
    const bids = r.bids.filter((b) => b.lot === i);
    const won = bids.filter((b) => b.outcome === "Won");
    console.log(
      `lot ${i} ${label(l.seller).padEnd(10)} ${String(l.quantity).padStart(5)} @ reserve ${fmtPrice(l.reserve)}  ` +
        `bids ${String(bids.length).padStart(2)}  sold ${String(l.sold).padStart(5)}  clearing ${fmtPrice(l.clearing)} NEAR/token  ` +
        `proceeds ${fmtNear(l.proceeds)} (+${fmtNear(l.penalties)} penalties)  winners ${won.map((b) => `${label(b.bidder)}×${b.filled}`).join(" ")}`,
    );
  });
  const unrevealed = r.bids.filter((b) => b.outcome === "Unrevealed").map((b) => label(b.bidder));
  if (unrevealed.length) console.log(`no-reveal (10% penalty): ${unrevealed.join(", ")}`);
}

if (cmd === "offline") {
  console.log(`offline swarm: ${BUYERS.length} buyers, ${SELLERS.length} sellers, ${ROUNDS} rounds, seed "${SEED}" (no chain, no LLM)`);
  const rounds = simulateOffline(ROUNDS, SEED);
  rounds.forEach((r) => printRound(r));
  const pnl = new Map<string, { spent: bigint; got: bigint; earned: bigint }>();
  for (const r of rounds) {
    for (const b of r.bids) {
      const p = pnl.get(b.bidder) ?? { spent: 0n, got: 0n, earned: 0n };
      p.spent += b.deposit - b.refund; p.got += b.filled; pnl.set(b.bidder, p);
    }
    for (const l of r.lots) {
      const p = pnl.get(l.seller) ?? { spent: 0n, got: 0n, earned: 0n };
      p.earned += l.proceeds + l.penalties; p.got -= l.sold; pnl.set(l.seller, p);
    }
  }
  console.log("\nagent            NEAR in/out     tokens");
  for (const [a, p] of pnl) console.log(`${a.padEnd(16)} ${fmtNear(p.earned - p.spent).padStart(10)}  ${String(p.got).padStart(7)}`);
  process.exit(0);
}

// ---------- chain ----------

const RPC = process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com";
const PARENT = process.env.SWARM_PARENT || "yeetpad-swarm.testnet";
if (!PARENT.endsWith(".testnet")) throw new Error("testnet only");
const MARKET = `market.${PARENT}`;
const FACTORY = process.env.FT_FACTORY_ACCOUNT_ID || "ft-factory.osl-launchpad-5786.testnet";
const EXPLORER = "https://testnet.nearblocks.io";
const SECRETS = resolve(homedir(), ".secrets");
const AGENTS_FILE = resolve(SECRETS, "swarm-agents.json");
const LIST_SECS = Number(flag("list", "25"));
const COMMIT_SECS = Number(flag("commit", "30"));
const REVEAL_SECS = Number(flag("reveal", "30"));
const TGAS = 10n ** 12n;
const yocto = (near: string) => BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n;

const provider = new JsonRpcProvider({ url: RPC });
const parentKey = JSON.parse(readFileSync(resolve(SECRETS, `near_${PARENT}.json`), "utf8")).private_key as KeyPairString;
const parent = new Account(PARENT, provider, parentKey);
const agentKeys: Record<string, KeyPairString> = existsSync(AGENTS_FILE) ? JSON.parse(readFileSync(AGENTS_FILE, "utf8")) : {};
const saveKeys = () => {
  writeFileSync(AGENTS_FILE, JSON.stringify(agentKeys, null, 1));
  chmodSync(AGENTS_FILE, 0o600);
};
const id = (name: string) => `${name}.${PARENT}`;
const agent = (name: string) => new Account(id(name), provider, agentKeys[id(name)]);
const tokenOf = (ticker: string) => `${ticker}.${FACTORY}`;
const short = (acct: string) => acct.replace(`.${PARENT}`, "");

async function rpc(method: string, params: unknown) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: any; error?: any };
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
async function exists(acct: string) {
  try { await provider.viewAccount({ accountId: acct }); return true; } catch { return false; }
}
async function view<T>(contractId: string, method: string, a: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args: a })) as T;
}
async function chainNowMs() {
  const b = await rpc("block", { finality: "optimistic" });
  return Math.floor(Number(BigInt(b.header.timestamp) / 1_000_000n));
}
async function waitChain(ms: number, what: string) {
  for (;;) {
    const now = await chainNowMs();
    if (now >= ms + 1200) return;
    const left = ms + 1200 - now;
    if (left > 3000) console.log(`  waiting ${Math.ceil(left / 1000)}s for ${what}`);
    await Bun.sleep(Math.min(left, 4000));
  }
}
function returnValue(tx: any): any {
  const v = tx?.status?.SuccessValue;
  if (v === undefined || v === "") return undefined;
  return JSON.parse(Buffer.from(v, "base64").toString());
}
function failure(tx: any): string | undefined {
  if (tx?.status?.Failure) return JSON.stringify(tx.status.Failure).slice(0, 300);
  for (const r of tx?.receipts_outcome ?? []) if (r.outcome?.status?.Failure) return JSON.stringify(r.outcome.status.Failure).slice(0, 300);
  return undefined;
}
async function call(who: Account, contractId: string, methodName: string, a: Record<string, unknown>, deposit = 0n, gas = 100n * TGAS) {
  const tx: any = await who.callFunctionRaw({ contractId, methodName, args: a, deposit, gas });
  return { hash: tx.transaction.hash as string, value: returnValue(tx), failure: failure(tx) };
}

type ChainLot = { seller: string; token: string; quantity: number; unit: string; reserve: string; status: string; sold: number; clearing_price: string; proceeds: string; penalties: string };
type ChainBid = { bidder: string; lot: number; hash: string; deposit: string; revealed: boolean; qty: number; price: string; outcome: string; filled: number; paid: string; fee: string; refund: string; delivery: string };
type ChainRound = { id: number; list_end_ms: number; commit_end_ms: number; reveal_end_ms: number; cleared: boolean; phase: string; lots: ChainLot[]; bids: ChainBid[]; notes: unknown[] };

async function allRounds(): Promise<ChainRound[]> {
  const n = await view<number>(MARKET, "get_round_count");
  const out: ChainRound[] = [];
  for (let f = 0; f < n; f += 20) out.push(...(await view<ChainRound[]>(MARKET, "get_rounds", { from: f, limit: 20 })));
  return out;
}
const historyOf = (rounds: ChainRound[]): History =>
  rounds.filter((r) => r.cleared).map((r) => r.lots.map((l) => ({ seller: l.seller, clearing: BigInt(l.clearing_price), sold: BigInt(l.sold), quantity: BigInt(l.quantity), reserve: BigInt(l.reserve) })));

// ---------- setup ----------

async function setup() {
  console.log(`setup: parent ${PARENT}, market ${MARKET}, factory ${FACTORY}`);
  const wasmPath = resolve(import.meta.dir, "../contracts/res/swarm_market.wasm");
  // 1. market contract
  if (!(await exists(MARKET))) {
    if (!existsSync(wasmPath)) throw new Error(`${wasmPath} missing: bun run contracts:build`);
    const r = await parent.createSubAccount({ accountOrPrefix: "market", publicKey: KeyPair.fromString(parentKey).getPublicKey(), nearToTransfer: yocto("3") });
    console.log(`created ${MARKET}: ${r.transaction.hash}`);
  }
  const market = new Account(MARKET, provider, parentKey);
  const code = await rpc("query", { request_type: "view_code", finality: "final", account_id: MARKET }).catch(() => null);
  const wasm = new Uint8Array(readFileSync(wasmPath));
  if (!code || code.code_base64 !== Buffer.from(wasm).toString("base64")) {
    const r = await market.deployContract(wasm);
    console.log(`deployed ${wasm.length} B to ${MARKET}: ${r.transaction.hash}`);
  }
  try {
    await view(MARKET, "get_config");
  } catch {
    const r = await call(market, MARKET, "new", { owner_id: PARENT }, 0n, 30n * TGAS);
    console.log(`init market (owner ${PARENT}): ${r.hash}`);
  }
  // 2. agent sub-accounts, each with its own key
  const agents = [...SELLERS.map((s) => ({ name: s.name, fund: "0.2" })), ...BUYERS.map((b) => ({ name: b.name, fund: b.strategy === "whale" ? "0.2" : "0.12" }))];
  for (const a of agents) {
    const acct = id(a.name);
    if (await exists(acct)) continue;
    const kp = KeyPair.fromRandom("ed25519");
    agentKeys[acct] = kp.toString() as KeyPairString;
    saveKeys();
    const r = await parent.createSubAccount({ accountOrPrefix: a.name, publicKey: kp.getPublicKey(), nearToTransfer: yocto(a.fund) });
    console.log(`created ${acct} (${a.fund} NEAR): ${r.transaction.hash}`);
  }
  // 3. each seller launches its own Yeetpad token through the Yeetpad factory, and registers the market on it
  const required = BigInt(await view<string>(FACTORY, "get_required_deposit"));
  await Promise.all(
    SELLERS.map(async (s) => {
      const token = tokenOf(s.ticker);
      const seller = agent(s.name);
      if (!(await exists(token))) {
        const meta = { spec: "ft-1.0.0", name: s.title, symbol: s.ticker.toUpperCase().slice(0, 9), icon: null, reference: null, reference_hash: null, decimals: 18 };
        const r = await call(seller, FACTORY, "create_token", { ticker: s.ticker, metadata: meta, total_supply: (1_000_000n * UNIT).toString(), owner_id: id(s.name) }, required, 60n * TGAS);
        console.log(`${s.name} launched ${token}: ${r.hash}${r.failure ? ` FAILED ${r.failure}` : ""}`);
      }
      const reg = await view<unknown>(token, "storage_balance_of", { account_id: MARKET });
      if (!reg) {
        const r = await call(seller, token, "storage_deposit", { account_id: MARKET, registration_only: true }, 1_250_000_000_000_000_000_000n, 30n * TGAS);
        console.log(`registered market on ${token}: ${r.hash}`);
      }
    }),
  );
  console.log("setup done");
}

// ---------- one round ----------

type Note = { kind: string; hash: string; account?: string; lot?: number; bid?: number };

async function runRound() {
  const before = await allRounds();
  const history = historyOf(before);
  const last = before[before.length - 1];
  if (last && !last.cleared) throw new Error(`round ${last.id} is not cleared yet (phase ${last.phase}); clear it first`);

  const notes: Note[] = [];
  const open = await call(parent, MARKET, "open_round", { list_secs: LIST_SECS, commit_secs: COMMIT_SECS, reveal_secs: REVEAL_SECS }, 0n, 30n * TGAS);
  if (open.failure) throw new Error(`open_round failed: ${open.failure}`);
  const round = open.value as number;
  notes.push({ kind: "open", hash: open.hash, account: PARENT });
  let r = (await view<ChainRound>(MARKET, "get_round", { round }))!;
  console.log(`\n=== round ${round} opened: ${EXPLORER}/txns/${open.hash}`);

  // Listing: every seller lists one lot of its token
  await Promise.all(
    SELLERS.map(async (s) => {
      const { quantity, reserve } = sellerLot(s.strategy, id(s.name), history);
      try {
        const res = await call(agent(s.name), tokenOf(s.ticker), "ft_transfer_call", {
          receiver_id: MARKET, amount: (quantity * UNIT).toString(), msg: JSON.stringify({ round, unit: UNIT.toString(), reserve: reserve.toString() }),
        }, 1n, 60n * TGAS);
        notes.push({ kind: "list", hash: res.hash, account: id(s.name) });
        console.log(`  ${s.name} [${s.strategy}] lists ${quantity} ${s.ticker} @ reserve ${fmtPrice(reserve)}: ${res.hash}${res.failure ? ` FAILED ${res.failure}` : ""}`);
      } catch (e) {
        console.log(`  ${s.name} listing failed: ${(e as Error).message.slice(0, 200)}`);
      }
    }),
  );
  await waitChain(r.list_end_ms, "commit phase");
  r = (await view<ChainRound>(MARKET, "get_round", { round }))!;
  const lots: LotView[] = r.lots.map((l, lot) => ({ lot, seller: l.seller, quantity: BigInt(l.quantity), reserve: BigInt(l.reserve) }));
  console.log(`  ${lots.length} lots listed`);

  // Commit: sealed bids with escrow
  const plans = new Map<string, BidPlan[]>();
  await Promise.all(
    BUYERS.map(async (b) => {
      const acct = id(b.name);
      const bal = BigInt((await provider.viewAccount({ accountId: acct })).amount);
      const mine = buyerBids(SEED, { name: acct, strategy: b.strategy }, round, lots, history).filter((p, i, all) => {
        const need = all.slice(0, i + 1).reduce((s, x) => s + x.deposit, 0n) + yocto("0.01");
        return need <= bal;
      });
      plans.set(acct, mine);
      for (const p of mine) {
        try {
          const res = await call(agent(b.name), MARKET, "commit", { round, lot: p.lot, hash: commitHash(round, p.lot, acct, p.qty, p.price, p.salt) }, p.deposit, 30n * TGAS);
          notes.push({ kind: "commit", hash: res.hash, account: acct, lot: p.lot });
          if (res.failure) console.log(`  ${b.name} commit failed: ${res.failure}`);
        } catch (e) {
          console.log(`  ${b.name} commit failed: ${(e as Error).message.slice(0, 200)}`);
        }
      }
    }),
  );
  r = (await view<ChainRound>(MARKET, "get_round", { round }))!;
  console.log(`  ${r.bids.length} sealed commits from ${new Set(r.bids.map((b) => b.bidder)).size} buyers`);
  await waitChain(r.commit_end_ms, "reveal phase");

  // Reveal (flakes may not)
  await Promise.all(
    BUYERS.map(async (b) => {
      const acct = id(b.name);
      for (const p of plans.get(acct) ?? []) {
        if (!p.willReveal) { console.log(`  ${b.name} [${b.strategy}] does not reveal lot ${p.lot}`); continue; }
        try {
          const res = await call(agent(b.name), MARKET, "reveal", { round, lot: p.lot, qty: Number(p.qty), price: p.price.toString(), salt: p.salt }, 0n, 30n * TGAS);
          notes.push({ kind: "reveal", hash: res.hash, account: acct, lot: p.lot });
          if (res.failure) console.log(`  ${b.name} reveal failed: ${res.failure}`);
        } catch (e) {
          console.log(`  ${b.name} reveal failed: ${(e as Error).message.slice(0, 200)}`);
        }
      }
    }),
  );
  await waitChain(r.reveal_end_ms, "clearing");

  // Clear (anyone can; the coordinator does it here) and deliver (each seller pushes its own lot)
  const clear = await call(parent, MARKET, "clear", { round }, 0n, 300n * TGAS);
  if (clear.failure) throw new Error(`clear failed: ${clear.failure}`);
  notes.push({ kind: "clear", hash: clear.hash, account: PARENT });
  console.log(`  cleared: ${EXPLORER}/txns/${clear.hash}`);
  for (let pass = 0; pass < 3; pass++) {
    r = (await view<ChainRound>(MARKET, "get_round", { round }))!;
    const todo = r.lots.map((_, lot) => r.bids.filter((b) => b.lot === lot && (b.delivery === "Pending" || b.delivery === "Failed")).length);
    if (todo.every((n) => n === 0)) break;
    // deliver is permissionless (R6.4). The coordinator pays: 300 Tgas needs ~0.3 NEAR of headroom, more than
    // an agent keeps. One call at a time because they share the coordinator's key.
    for (let lot = 0; lot < r.lots.length; lot++) {
      for (let left = todo[lot]; left > 0; left -= 5) {
        try {
          const res = await call(parent, MARKET, "deliver", { round, lot, limit: 5 }, 0n, 300n * TGAS);
          notes.push({ kind: "deliver", hash: res.hash, account: PARENT, lot });
          if (res.failure) console.log(`  deliver lot ${lot}: a receipt failed: ${res.failure}`);
        } catch (e) {
          console.log(`  deliver lot ${lot} failed: ${(e as Error).message.slice(0, 200)}`);
        }
      }
    }
    await Bun.sleep(3000);
  }

  // Publish the tx log on-chain (R7.2) for the /swarm page
  r = (await view<ChainRound>(MARKET, "get_round", { round }))!;
  const bidIdx = (acct?: string, lot?: number) => r.bids.findIndex((b) => b.bidder === acct && b.lot === lot);
  const withBids = notes.map((n) => ({ ...n, bid: n.kind === "commit" || n.kind === "reveal" ? bidIdx(n.account, n.lot) : undefined }));
  for (let i = 0; i < withBids.length; i += 60) {
    await call(parent, MARKET, "annotate", { round, notes: withBids.slice(i, i + 60) }, 0n, 150n * TGAS);
  }

  printRound(
    {
      round,
      lots: r.lots.map((l) => ({ seller: l.seller, token: l.token, quantity: BigInt(l.quantity), reserve: BigInt(l.reserve), sold: BigInt(l.sold), clearing: BigInt(l.clearing_price), proceeds: BigInt(l.proceeds), penalties: BigInt(l.penalties), status: l.status as any })),
      bids: r.bids.map((b) => ({ ...b, deposit: BigInt(b.deposit), qty: BigInt(b.qty), price: BigInt(b.price), filled: BigInt(b.filled), paid: BigInt(b.paid), fee: BigInt(b.fee), refund: BigInt(b.refund), outcome: b.outcome as any })),
    },
    short,
  );
  const deliveries = r.bids.filter((b) => b.outcome === "Won").map((b) => b.delivery);
  console.log(`  deliveries: ${deliveries.filter((d) => d === "Delivered").length}/${deliveries.length} delivered`);
}

if (cmd === "status") {
  const rounds = await allRounds();
  console.log(`${MARKET}: ${rounds.length} rounds`);
  for (const r of rounds.slice(-5)) console.log(`round ${r.id} ${r.phase}: ${r.lots.length} lots, ${r.bids.length} bids, clearing ${r.lots.map((l) => fmtPrice(BigInt(l.clearing_price))).join(" / ")}`);
  process.exit(0);
}
if (cmd === "setup" || cmd === "run") await setup();
if (cmd === "run") {
  for (let i = 0; i < ROUNDS; i++) await runRound();
  console.log(`\ndone. live page: https://yeetpad.fun/swarm/`);
}

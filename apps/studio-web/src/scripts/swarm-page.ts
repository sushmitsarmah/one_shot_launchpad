// Swarm Market live page: reads the swarm-market contract and the agents' balances straight from testnet RPC
// (no API in between) and refreshes every few seconds.
const RPC = "https://test.rpc.fastnear.com";
const PARENT = "yeetpad-swarm.testnet";
const MARKET = `market.${PARENT}`;
const EXPLORER = "https://testnet.nearblocks.io";
const NEAR = 10n ** 24n;

// Mirrors scripts/swarm/engine.ts (SELLERS / BUYER_PLAN).
const SELLER_STRATEGY: Record<string, [string, string]> = {
  "seller-1": ["anchor", "Fixed reserve, fixed 1,000-token lots"],
  "seller-2": ["adaptive", "Reserve = 90% of its last clearing price"],
  "seller-3": ["premium", "High reserve, small 600-token lots"],
  "seller-4": ["dumper", "Low reserve, big 2,000-token lots"],
  "seller-5": ["scarcity", "Shrinks lots after a sell-out, grows them after unsold stock"],
};
const BUYER_PLAN = ["truthful", "truthful", "truthful", "shader", "shader", "shader", "bargain", "bargain", "bargain", "momentum", "momentum", "momentum", "whale", "whale", "flake", "flake", "splitter", "splitter", "splitter", "shader"];
const BUYER_BLURB: Record<string, string> = {
  truthful: "Bids its true value",
  shader: "Bids 80% of its value",
  bargain: "Bids just above the reserve on the cheapest lot",
  momentum: "Last clearing price +10%, capped at its value",
  whale: "Big quantities at a moderate price",
  flake: "Sometimes never reveals (pays the 10% penalty)",
  splitter: "Splits demand over two lots",
};
const COLORS = ["#ff4fa3", "#7b5cff", "#ff7a1a", "#0aa36b", "#4cc9f0"];

type Lot = { seller: string; token: string; quantity: number; unit: string; reserve: string; status: string; sold: number; clearing_price: string; proceeds: string; penalties: string };
type Bid = { bidder: string; lot: number; hash: string; deposit: string; committed_at_ms: number; revealed: boolean; qty: number; price: string; outcome: string; filled: number; paid: string; fee: string; refund: string; delivery: string };
type Note = { kind: string; hash: string; account?: string | null; lot?: number | null; bid?: number | null };
type Round = { id: number; opened_at_ms: number; list_end_ms: number; commit_end_ms: number; reveal_end_ms: number; cleared_at_ms: number; cleared: boolean; lots: Lot[]; bids: Bid[]; notes: Note[]; phase: string; now_ms: number };

async function rpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
async function view<T>(method: string, args: object): Promise<T> {
  const res = await rpc("query", { request_type: "call_function", finality: "optimistic", account_id: MARKET, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}
async function balance(acct: string): Promise<bigint | null> {
  try {
    return BigInt((await rpc("query", { request_type: "view_account", finality: "optimistic", account_id: acct })).amount);
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a: string) => a.replace(`.${PARENT}`, "");
const tokenName = (t: string) => t.split(".")[0];
const near = (y: bigint, dp = 4) => {
  const neg = y < 0n;
  const a = neg ? -y : y;
  return `${neg ? "−" : ""}${a / NEAR}.${(a % NEAR).toString().padStart(24, "0").slice(0, dp)}`;
};
/** yocto per whole token → NEAR per token */
const ppt = (y: string | bigint) => (Number(BigInt(y)) / 1e24).toFixed(7);
const tx = (h: string, label: string) => `<a href="${EXPLORER}/txns/${esc(h)}" target="_blank" rel="noreferrer">${esc(label)} ↗</a>`;
const acctLink = (a: string) => `<a href="${EXPLORER}/address/${esc(a)}" target="_blank" rel="noreferrer">${esc(short(a))}</a>`;
const tag = (s: string) => `<span class="sw-tag ${esc(s)}">${esc(s)}</span>`;
const strategyOf = (a: string) => {
  const s = short(a);
  if (SELLER_STRATEGY[s]) return SELLER_STRATEGY[s];
  const n = Number(s.replace("buyer-", ""));
  const st = BUYER_PLAN[n - 1] ?? "?";
  return [st, BUYER_BLURB[st] ?? ""];
};
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

async function allRounds(): Promise<Round[]> {
  const n = await view<number>("get_round_count", {});
  const out: Round[] = [];
  for (let f = 0; f < n; f += 20) out.push(...(await view<Round[]>("get_rounds", { from: f, limit: 20 })));
  return out;
}

function renderNow(rounds: Round[]) {
  const r = rounds[rounds.length - 1];
  const phaseEl = document.getElementById("now-phase")!;
  const detail = document.getElementById("now-detail")!;
  if (!r) {
    phaseEl.textContent = "no rounds yet";
    return;
  }
  const order = ["Listing", "Commit", "Reveal", "Clearing", "Cleared"];
  const idx = order.indexOf(r.phase);
  document.querySelectorAll<HTMLLIElement>("#now-steps li").forEach((li, i) => {
    li.classList.toggle("on", i === idx);
    li.classList.toggle("done", i < idx);
  });
  phaseEl.textContent = `Round ${r.id}: ${r.phase === "Cleared" ? "settled" : r.phase}`;
  const end = r.phase === "Listing" ? r.list_end_ms : r.phase === "Commit" ? r.commit_end_ms : r.phase === "Reveal" ? r.reveal_end_ms : 0;
  detail.textContent = end
    ? `${Math.max(0, Math.ceil((end - r.now_ms) / 1000))}s left · ${r.lots.length} lots · ${r.bids.length} sealed bids`
    : r.phase === "Cleared"
      ? `settled at ${time(r.cleared_at_ms)} · waiting for the next round`
      : "ready to clear (anyone can call clear)";
}

function renderStats(rounds: Round[]) {
  const settled = rounds.filter((r) => r.cleared);
  const vol = settled.flatMap((r) => r.lots).reduce((s, l) => s + BigInt(l.proceeds), 0n);
  const toks = settled.flatMap((r) => r.bids).filter((b) => b.delivery === "Delivered").reduce((s, b) => s + b.filled, 0);
  document.getElementById("st-rounds")!.textContent = String(settled.length);
  document.getElementById("st-volume")!.textContent = near(vol, 3);
  document.getElementById("st-tokens")!.textContent = toks.toLocaleString();
  document.getElementById("st-bids")!.textContent = String(rounds.reduce((s, r) => s + r.bids.length, 0));
}

function renderChart(rounds: Round[]) {
  const settled = rounds.filter((r) => r.cleared);
  const el = document.getElementById("sw-chart")!;
  if (!settled.length) {
    el.innerHTML = `<p class="sw-muted">No settled rounds yet.</p>`;
    return;
  }
  const sellers = Object.keys(SELLER_STRATEGY).map((s) => `${s}.${PARENT}`);
  const pts = sellers.map((s) => settled.map((r) => {
    const l = r.lots.find((x) => x.seller === s);
    return l && l.sold > 0 ? Number(BigInt(l.clearing_price)) / 1e24 : null;
  }));
  const max = Math.max(1e-9, ...pts.flat().filter((x): x is number => x !== null)) * 1.15;
  const W = 640, H = 260, L = 84, B = 30, T = 12, R = 16;
  const x = (i: number) => L + (settled.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (settled.length - 1));
  const y = (v: number) => H - B - (v / max) * (H - B - T);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Clearing price per seller per round">`;
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#1b1433" stroke-opacity="0.12"/><text x="${L - 6}" y="${y(v) + 4}" font-size="11" text-anchor="end">${v.toFixed(7)}</text>`;
  }
  settled.forEach((r, i) => (svg += `<text x="${x(i)}" y="${H - 8}" font-size="11" text-anchor="middle">r${r.id}</text>`));
  pts.forEach((line, si) => {
    let d = "";
    line.forEach((v, i) => {
      if (v === null) return;
      d += `${d && line[i - 1] !== null ? "L" : "M"}${x(i)},${y(v)} `;
    });
    if (d) svg += `<path d="${d}" fill="none" stroke="${COLORS[si]}" stroke-width="3"/>`;
    line.forEach((v, i) => v !== null && (svg += `<circle cx="${x(i)}" cy="${y(v)}" r="4.5" fill="${COLORS[si]}" stroke="#1b1433" stroke-width="2"><title>${short(sellers[si])} r${settled[i].id}: ${v.toFixed(7)} NEAR/token</title></circle>`));
  });
  svg += "</svg>";
  const tokens = sellers.map((s) => rounds.flatMap((r) => r.lots).find((l) => l.seller === s)?.token);
  el.innerHTML = svg + `<div class="sw-legend">${sellers.map((s, i) => `<span><i style="background:${COLORS[i]}"></i>${esc(short(s))} · $${esc(tokenName(tokens[i] ?? "?").toUpperCase())}</span>`).join("")}</div>`;
}

async function renderAgents(rounds: Round[]) {
  const agents = [...Object.keys(SELLER_STRATEGY), ...BUYER_PLAN.map((_, i) => `buyer-${i + 1}`)].map((s) => `${s}.${PARENT}`);
  const bals = await Promise.all(agents.map(balance));
  const settled = rounds.filter((r) => r.cleared);
  const rows = agents.map((a, i) => {
    let net = 0n, toks = 0, won = 0, bids = 0;
    for (const r of settled) {
      for (const b of r.bids.filter((x) => x.bidder === a)) {
        net -= BigInt(b.deposit) - BigInt(b.refund);
        toks += b.filled;
        bids++;
        if (b.outcome === "Won") won++;
      }
      for (const l of r.lots.filter((x) => x.seller === a)) {
        net += BigInt(l.proceeds) + BigInt(l.penalties);
        toks -= l.sold;
      }
    }
    const [st, blurb] = strategyOf(a);
    const isSeller = a.startsWith("seller-");
    return `<tr><td>${acctLink(a)}</td><td title="${esc(blurb)}">${esc(st)}</td><td class="num">${bals[i] === null ? "–" : near(bals[i]!)}</td>` +
      `<td class="num ${net > 0n ? "sw-pos" : net < 0n ? "sw-neg" : ""}">${net === 0n ? "0" : (net > 0n ? "+" : "") + near(net, 5)}</td>` +
      `<td class="num">${toks > 0 ? "+" : ""}${toks.toLocaleString()}</td><td class="num">${isSeller ? "–" : `${won} / ${bids}`}</td></tr>`;
  });
  document.querySelector("#sw-agents tbody")!.innerHTML = rows.join("");
}

function renderRounds(rounds: Round[], openIds: Set<number>) {
  const el = document.getElementById("sw-rounds")!;
  if (!rounds.length) {
    el.innerHTML = `<p class="sw-muted">No rounds yet.</p>`;
    return;
  }
  el.innerHTML = [...rounds].reverse().map((r, i) => {
    const noteFor = (kind: string, pred: (n: Note) => boolean = () => true) => r.notes.find((n) => n.kind === kind && pred(n));
    const open = noteFor("open"), clear = noteFor("clear");
    const delivers = r.notes.filter((n) => n.kind === "deliver");
    const volume = r.lots.reduce((s, l) => s + BigInt(l.proceeds), 0n);
    const lots = r.lots.map((l, li) => {
      const list = noteFor("list", (n) => n.account === l.seller);
      return `<tr><td>${li}</td><td>${acctLink(l.seller)}</td><td><a href="${EXPLORER}/token/${esc(l.token)}" target="_blank" rel="noreferrer">$${esc(tokenName(l.token).toUpperCase())}</a></td>` +
        `<td class="num">${l.quantity.toLocaleString()}</td><td class="num">${ppt(l.reserve)}</td><td class="num">${l.sold.toLocaleString()}</td>` +
        `<td class="num"><b>${l.sold ? ppt(l.clearing_price) : "–"}</b></td><td class="num">${near(BigInt(l.proceeds), 5)}</td><td class="num">${near(BigInt(l.penalties), 5)}</td>` +
        `<td>${tag(l.status)}</td><td>${list ? tx(list.hash, "list") : ""}</td></tr>`;
    }).join("");
    const bids = r.bids.map((b, bi) => {
      const c = noteFor("commit", (n) => n.bid === bi), v = noteFor("reveal", (n) => n.bid === bi);
      const [st] = strategyOf(b.bidder);
      return `<tr><td>${acctLink(b.bidder)} <span class="sw-muted">${esc(st)}</span></td><td class="num">${b.lot}</td><td><code title="${esc(b.hash)}">${esc(b.hash.slice(0, 10))}…</code></td>` +
        `<td class="num">${near(BigInt(b.deposit), 3)}</td><td class="num">${b.revealed ? `${b.qty.toLocaleString()} @ ${ppt(b.price)}` : "sealed"}</td>` +
        `<td>${tag(b.outcome)}</td><td class="num">${b.filled ? b.filled.toLocaleString() : ""}</td><td class="num">${BigInt(b.paid) ? near(BigInt(b.paid), 5) : ""}</td>` +
        `<td class="num">${r.cleared ? near(BigInt(b.refund), 5) : ""}</td><td>${b.delivery === "None" ? "" : tag(b.delivery)}</td>` +
        `<td>${c ? tx(c.hash, "commit") : ""} ${v ? tx(v.hash, "reveal") : ""}</td></tr>`;
    }).join("");
    const isOpen = openIds.size ? openIds.has(r.id) : i === 0;
    return `<details class="sw-card sw-round" data-id="${r.id}" ${isOpen ? "open" : ""}><summary><h3>Round ${r.id}</h3>${tag(r.cleared ? "Cleared" : r.phase)}` +
      `<span class="sw-muted">opened ${time(r.opened_at_ms)} · ${r.lots.length} lots · ${r.bids.length} bids · ${near(volume, 4)} NEAR traded</span></summary>` +
      `<div class="sw-round-body"><div class="sw-txs">${open ? tx(open.hash, "open_round") : ""}${clear ? tx(clear.hash, "clear (refunds + seller payouts)") : ""}${delivers.map((d) => tx(d.hash, `deliver lot ${d.lot}`)).join("")}</div>` +
      `<div><h4>Lots</h4><div class="sw-table-wrap"><table class="sw-table"><thead><tr><th>#</th><th>Seller</th><th>Token</th><th class="num">Qty</th><th class="num">Reserve</th><th class="num">Sold</th><th class="num">Clearing price</th><th class="num">Proceeds</th><th class="num">Penalties</th><th>Status</th><th>Tx</th></tr></thead><tbody>${lots}</tbody></table></div></div>` +
      `<div><h4>Sealed bids</h4><div class="sw-table-wrap"><table class="sw-table"><thead><tr><th>Buyer</th><th class="num">Lot</th><th>Commit hash</th><th class="num">Deposit</th><th class="num">Reveal (qty @ NEAR/token)</th><th>Outcome</th><th class="num">Filled</th><th class="num">Paid</th><th class="num">Refund</th><th>Delivery</th><th>Tx</th></tr></thead><tbody>${bids || `<tr><td colspan="11" class="sw-muted">No bids yet.</td></tr>`}</tbody></table></div></div>` +
      `<p class="sw-muted">Prices are NEAR per whole token. Winners pay the lot's clearing price (never more than their bid) plus a 0.00125 NEAR token-registration fee.</p></div></details>`;
  }).join("");
}

let agentsAt = 0;
let lastKey = "";
async function tick() {
  try {
    const rounds = await allRounds();
    const openIds = new Set([...document.querySelectorAll<HTMLDetailsElement>("#sw-rounds details")].filter((d) => d.open).map((d) => Number(d.dataset.id)));
    renderNow(rounds);
    // Only rebuild the tables when something changed on chain (keeps scroll position and open rounds).
    const key = JSON.stringify(rounds.map((r) => ({ ...r, now_ms: 0, phase: r.phase })));
    if (key !== lastKey) {
      lastKey = key;
      renderStats(rounds);
      renderChart(rounds);
      renderRounds(rounds, openIds);
    }
    if (Date.now() - agentsAt > 15000) {
      agentsAt = Date.now();
      await renderAgents(rounds);
    }
  } catch (e) {
    document.getElementById("now-detail")!.textContent = `couldn't reach testnet RPC (${(e as Error).message.slice(0, 80)}), retrying…`;
  }
}
tick();
setInterval(tick, 5000);

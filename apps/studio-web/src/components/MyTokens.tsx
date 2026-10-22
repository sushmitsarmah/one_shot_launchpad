import { useEffect, useMemo, useState } from "react";
import { tokenIconDataUri, type LaunchedToken } from "@osl/schema";
import { EXPLORER_BASE } from "../lib/config";
import { REMOVE_MAX_FEE_NEAR, type DclPosition } from "../lib/dcl";

type VenueFilter = "all" | "unlisted" | "listed" | "rhea" | "nearly" | "justhoot";
type Sort = "new" | "old" | "name";
const VENUE_LABEL: Record<string, string> = { yeetpad: "Not listed", rhea: "Rhea", nearly: "Nearly", justhoot: "JustHoot" };

const venueOf = (l: LaunchedToken) => l.venue ?? "yeetpad";
const isListed = (l: LaunchedToken) => venueOf(l) !== "yeetpad";
/** JustHoot is mainnet-only and is linked to nearblocks.io (same as the API's explorerUrl for it). */
const txUrl = (l: LaunchedToken) => (l.txHash ? `${venueOf(l) === "justhoot" ? "https://nearblocks.io" : EXPLORER_BASE}/txns/${l.txHash}` : null);
const siteHref = (l: LaunchedToken) => `/t/${l.slug ?? l.ticker}`;

/**
 * Studio → My tokens: every token the signed-in creator launched (factory registry + Nearly/JustHoot KV
 * index, via /api/launches/<account>), with links, search/filter/sort, bulk "List on Rhea" and CSV export.
 */
export default function MyTokens({
  account,
  launches,
  busy,
  progress,
  onReload,
  onListOnRhea,
  onDelete,
  onRestore,
  loadPositions,
  notice,
}: {
  account: string;
  launches: LaunchedToken[] | null;
  busy: boolean;
  progress: string | null;
  onReload: () => void;
  onListOnRhea: (tokenIds: string[]) => void;
  /** Takes the sites down first, then (optionally) signs DCL remove_liquidity for `positions`. */
  onDelete: (tickers: string[], positions: { ticker: string; p: DclPosition }[]) => void;
  onRestore: (tickers: string[]) => void;
  /** Creator's removable / farmed DCL positions per tokenId (one view call). */
  loadPositions: (tokenIds: string[]) => Promise<Map<string, { removable: DclPosition[]; farmed: DclPosition[] }>>;
  notice: string | null;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<VenueFilter>("all");
  const [sort, setSort] = useState<Sort>("new");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [confirmDel, setConfirmDel] = useState<LaunchedToken[] | null>(null);

  const everything = launches ?? [];
  const deletedCount = everything.filter((l) => l.deletedAt).length;
  const all = showDeleted ? everything : everything.filter((l) => !l.deletedAt);
  const totals = useMemo(() => {
    const live = everything.filter((l) => !l.deletedAt);
    const listed = live.filter(isListed).length;
    return { tokens: live.length, listed, unlisted: live.length - listed };
  }, [everything]);
  const canRelist = (l: LaunchedToken) => l.ownerId === account && venueOf(l) === "yeetpad" && !l.deletedAt;

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = all.filter((l) => {
      const v = venueOf(l);
      if (filter === "unlisted" && v !== "yeetpad") return false;
      if (filter === "listed" && v === "yeetpad") return false;
      if ((filter === "rhea" || filter === "nearly" || filter === "justhoot") && v !== filter) return false;
      if (!needle) return true;
      return [l.name, l.ticker, l.slug, l.tokenId].some((x) => (x ?? "").toLowerCase().includes(needle));
    });
    return rows.sort((a, b) =>
      sort === "name" ? (a.name ?? a.ticker).localeCompare(b.name ?? b.ticker) : sort === "old" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt,
    );
  }, [all, q, filter, sort]);
  const visibleSel = visible.filter((l) => sel.has(l.tokenId));
  const allSel = visible.length > 0 && visibleSel.length === visible.length;
  const relistable = visibleSel.filter(canRelist);
  const deletable = visibleSel.filter((l) => !l.deletedAt);
  const restorable = visibleSel.filter((l) => l.deletedAt && !l.deletedByAdmin);

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {}
  };

  const exportCsv = () => {
    const cols = ["name", "ticker", "launched", "site", "contract", "contract_url", "launch_tx", "venue", "venue_url", "views"];
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")].concat(
      visible.map((l) =>
        [l.name ?? "", l.ticker, new Date(l.createdAt).toISOString(), new URL(siteHref(l), location.origin).toString(), l.tokenId, l.explorerUrl, txUrl(l) ?? "", VENUE_LABEL[venueOf(l)], l.venueUrl ?? "", l.views ?? ""]
          .map(esc)
          .join(","),
      ),
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `yeetpad-tokens-${account}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const filters: [VenueFilter, string, number][] = [
    ["all", "All", totals.tokens],
    ["unlisted", "Not listed", totals.unlisted],
    ["listed", "Listed", totals.listed],
    ["rhea", "Rhea", all.filter((l) => venueOf(l) === "rhea").length],
    ["nearly", "Nearly", all.filter((l) => venueOf(l) === "nearly").length],
    ["justhoot", "JustHoot", all.filter((l) => venueOf(l) === "justhoot").length],
  ];

  return (
    <div className="admin tokens-dash">
      <section className="card admin-card">
        <div className="row between admin-head">
          <div>
            <h2>My tokens</h2>
            <p className="muted small">Everything <strong>{account}</strong> launched on Yeetpad, Rhea, Nearly and JustHoot.</p>
          </div>
          <div className="admin-stats">
            <span className="stat"><b>{totals.tokens}</b> tokens</span>
            <span className="stat stat-ok"><b>{totals.listed}</b> listed</span>
            <span className="stat"><b>{totals.unlisted}</b> not listed</span>
            {deletedCount > 0 && <span className="stat"><b>{deletedCount}</b> taken down</span>}
          </div>
        </div>
        <div className="row admin-tools">
          <input className="admin-search" placeholder="Search name, ticker, contract…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="search tokens" />
          <div className="venue-pick admin-filter" role="radiogroup" aria-label="filter by venue">
            {filters.map(([f, label, n]) => (
              <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {label}<span className="admin-n">{n}</span>
              </button>
            ))}
          </div>
          <label className="small">
            Sort{" "}
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="sort">
              <option value="new">Newest</option>
              <option value="old">Oldest</option>
              <option value="name">Name</option>
            </select>
          </label>
          <label className="small pick">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted{deletedCount ? ` (${deletedCount})` : ""}
          </label>
          <button className="ghost" onClick={onReload} disabled={busy}>Refresh</button>
          <button className="ghost" onClick={exportCsv} disabled={!visible.length}>Export CSV</button>
        </div>
        {visibleSel.length > 0 && (
          <div className="row admin-bulk">
            <strong>{visibleSel.length} selected</strong>
            <button disabled={busy || relistable.length === 0} onClick={() => onListOnRhea(relistable.map((l) => l.tokenId))} title="One wallet approval per token">
              List {relistable.length} on Rhea
            </button>
            {relistable.length < visibleSel.length && <span className="muted small">{visibleSel.length - relistable.length} already listed or not held by you</span>}
            {deletable.length > 0 && (
              <button className="ghost danger" disabled={busy} onClick={() => setConfirmDel(deletable)}>Delete {deletable.length}…</button>
            )}
            {restorable.length > 0 && (
              <button className="ghost" disabled={busy} onClick={() => onRestore(restorable.map((l) => l.ticker))}>Restore {restorable.length}</button>
            )}
            <button className="link" onClick={() => setSel(new Set())}>clear</button>
          </div>
        )}
        {progress && <p className="muted small">{progress}</p>}
        {notice && <p className="admin-msg">{notice}</p>}
        {confirmDel && (
          <DeleteDialog
            tokens={confirmDel}
            loadPositions={loadPositions}
            onCancel={() => setConfirmDel(null)}
            onConfirm={(positions) => {
              const t = confirmDel.map((l) => l.ticker);
              setConfirmDel(null);
              setSel(new Set());
              onDelete(t, positions);
            }}
          />
        )}
        <div className="admin-table-wrap">
          <table className="admin-table tokens-table">
            <thead>
              <tr>
                <th className="c-check">
                  <input
                    type="checkbox"
                    aria-label="select all visible"
                    checked={allSel}
                    ref={(el) => {
                      if (el) el.indeterminate = visibleSel.length > 0 && !allSel;
                    }}
                    onChange={(e) =>
                      setSel((s) => {
                        const n = new Set(s);
                        for (const v of visible) e.target.checked ? n.add(v.tokenId) : n.delete(v.tokenId);
                        return n;
                      })
                    }
                  />
                </th>
                <th>Token</th>
                <th>Ticker</th>
                <th>Launched</th>
                <th>Site</th>
                <th>Contract</th>
                <th>Tx</th>
                <th>Venue</th>
                <th>Views</th>
                <th className="c-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {launches === null ? (
                <tr><td colSpan={10} className="muted admin-empty">Loading…</td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={10} className="muted admin-empty">{all.length ? "Nothing matches." : "Nothing yeeted yet. Launch from the Studio tab."}</td></tr>
              ) : (
                visible.map((l) => {
                  const v = venueOf(l);
                  const tx = txUrl(l);
                  return (
                    <tr key={l.tokenId} className={`${sel.has(l.tokenId) ? "is-sel" : ""}${l.deletedAt ? " is-deleted" : ""}`}>
                      <td className="c-check">
                        <input
                          type="checkbox"
                          aria-label={`select ${l.ticker}`}
                          checked={sel.has(l.tokenId)}
                          onChange={(e) => setSel((s) => { const n = new Set(s); e.target.checked ? n.add(l.tokenId) : n.delete(l.tokenId); return n; })}
                        />
                      </td>
                      <td className="c-name">
                        {l.colors ? (
                          <img src={tokenIconDataUri({ ticker: l.ticker, colors: l.colors })} alt="" width={28} height={28} loading="lazy" />
                        ) : (
                          <span className="dot" />
                        )}
                        <a href={siteHref(l)}>{l.name ?? l.ticker.toUpperCase()}</a>
                      </td>
                      <td><strong>${l.ticker.toUpperCase()}</strong></td>
                      <td className="c-when" title={new Date(l.createdAt).toLocaleString()}>{fmtDate(l.createdAt)}</td>
                      <td><a href={siteHref(l)}>/t/{l.slug ?? l.ticker}</a></td>
                      <td className="c-contract">
                        <a href={l.explorerUrl} target="_blank" rel="noreferrer" title={l.tokenId}><code>{short(l.tokenId)}</code></a>{" "}
                        <button className="link" onClick={() => copy(l.tokenId)} aria-label={`copy ${l.tokenId}`}>{copied === l.tokenId ? "copied" : "copy"}</button>
                      </td>
                      <td>{tx ? <a href={tx} target="_blank" rel="noreferrer">tx ↗</a> : <span className="muted">-</span>}</td>
                      <td>
                        {l.deletedAt ? (
                          <span className="badge badge-del" title={new Date(l.deletedAt).toLocaleString()}>{l.deletedByAdmin ? "taken down (moderator)" : "taken down"}</span>
                        ) : null}{" "}
                        <span className={`badge ${v === "yeetpad" ? "" : "badge-ok"}`}>{VENUE_LABEL[v]}</span>{" "}
                        {v !== "yeetpad" && l.venueUrl && (
                          <a href={l.venueUrl} target="_blank" rel="noreferrer" className="small">{v === "rhea" ? "pool ↗" : "page ↗"}</a>
                        )}
                      </td>
                      <td className="num">{l.views ?? 0}</td>
                      <td className="c-actions">
                        <a className="small" href={siteHref(l)}>open</a>{" "}
                        {canRelist(l) && (
                          <button className="mini" disabled={busy} onClick={() => onListOnRhea([l.tokenId])}>List on Rhea</button>
                        )}{" "}
                        {l.deletedAt ? (
                          !l.deletedByAdmin && <button className="ghost" disabled={busy} onClick={() => onRestore([l.ticker])}>Restore</button>
                        ) : (
                          <button className="ghost danger" disabled={busy} onClick={() => setConfirmDel([l])}>Delete</button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="muted small">Delete takes the Yeetpad page offline and hides the token here (restore any time); the token itself stays on the blockchain. Views are approximate page views of each token's site (no cookies). Listing on Rhea asks your wallet to send the tokens to the vault, one approval per token.</p>
      </section>
    </div>
  );
}

const short = (id: string) => (id.length > 34 ? `${id.slice(0, 16)}…${id.slice(-14)}` : id);
function fmtDate(ms: number) {
  return new Date(ms).toLocaleString(undefined, { year: "2-digit", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Danger confirm: what Delete does and doesn't do, plus the optional Rhea liquidity withdrawal and its cost. */
function DeleteDialog({
  tokens,
  loadPositions,
  onCancel,
  onConfirm,
}: {
  tokens: LaunchedToken[];
  loadPositions: (tokenIds: string[]) => Promise<Map<string, { removable: DclPosition[]; farmed: DclPosition[] }>>;
  onCancel: () => void;
  onConfirm: (positions: { ticker: string; p: DclPosition }[]) => void;
}) {
  const [pos, setPos] = useState<{ ticker: string; p: DclPosition }[] | null>(null);
  const [farmed, setFarmed] = useState(0);
  const [posErr, setPosErr] = useState<string | null>(null);
  const [pull, setPull] = useState(true);
  useEffect(() => {
    loadPositions(tokens.map((t) => t.tokenId))
      .then((m) => {
        const list: { ticker: string; p: DclPosition }[] = [];
        let f = 0;
        for (const t of tokens) {
          const r = m.get(t.tokenId);
          for (const p of r?.removable ?? []) list.push({ ticker: t.ticker, p });
          f += r?.farmed.length ?? 0;
        }
        setPos(list);
        setFarmed(f);
        setPull(list.length > 0);
      })
      .catch((e) => (setPos([]), setPosErr((e as Error).message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const n = tokens.length;
  const approvals = pos ? Math.ceil(pos.length / 10) : 0;
  return (
    <div className="danger-dialog" role="alertdialog" aria-modal="true" aria-labelledby="del-title">
      <div className="card danger-card">
        <h2 id="del-title">Delete {n === 1 ? `$${tokens[0].ticker.toUpperCase()}` : `${n} tokens`}?</h2>
        <ul className="del-facts">
          <li><strong>The token itself stays on the NEAR blockchain.</strong> Nobody can delete it; holders keep their tokens and it can still be traded wherever it's listed.</li>
          <li>The Yeetpad page{n > 1 ? "s" : ""} at <code>/t/…</code> go{n > 1 ? "" : "es"} offline (visitors see "taken down by its creator") and {n > 1 ? "they're" : "it's"} hidden from My tokens. You can restore {n > 1 ? "them" : "it"} later.</li>
          <li>
            {pos === null ? (
              <span className="muted">Checking your Rhea liquidity…</span>
            ) : pos.length === 0 ? (
              <span className="muted">No Rhea liquidity of yours to pull{posErr ? ` (couldn't check: ${posErr})` : ""}.</span>
            ) : (
              <label className="pick">
                <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} /> Also pull my liquidity from Rhea: {pos.length} position{pos.length > 1 ? "s" : ""}
              </label>
            )}
            {pos && pos.length > 0 && (
              <p className="small muted">
                Your wallet signs one <code>remove_liquidity</code> per position ({pos.length} transaction{pos.length > 1 ? "s" : ""}, {approvals} wallet approval{approvals > 1 ? "s" : ""}, up to 10 each).
                No deposit; gas only, at most ~{REMOVE_MAX_FEE_NEAR.toFixed(3)} NEAR per transaction (usually under 0.002, the rest is refunded).
                The tokens and NEAR in the pool go straight back to your wallet. The pool stays on Rhea, empty of your liquidity. This runs after the pages are taken down; if you reject it, the pages stay down.
              </p>
            )}
            {farmed > 0 && <p className="small muted">{farmed} position{farmed > 1 ? "s are" : " is"} staked in a farm; unstake on Rhea first to pull {farmed > 1 ? "them" : "it"}.</p>}
          </li>
        </ul>
        <div className="row">
          <button className="danger" disabled={pos === null} onClick={() => onConfirm(pull && pos ? pos : [])}>
            Delete{pull && pos?.length ? " + pull liquidity" : ""}
          </button>
          <button className="ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

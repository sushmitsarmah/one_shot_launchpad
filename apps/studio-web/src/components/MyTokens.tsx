import { useEffect, useMemo, useState } from "react";
import { tokenIconDataUri, type IntentsConfig, type IntentsMode, type LaunchedToken, type LooftaToggle } from "@osl/schema";
import { LOOFTA_TARGET_KINDS, payToFrom, type LooftaTargetKind } from "./LooftaKey";
import { isMainnetAccount } from "../lib/intents";
import { EXPLORER_BASE } from "../lib/config";
import {
  fmtUnits,
  minsFor,
  poolTokens,
  quotePosition,
  REMOVE_MAX_FEE_NEAR,
  SLIPPAGE_DEFAULT,
  SLIPPAGE_MAX,
  SLIPPAGE_MIN,
  SLIPPAGE_PRESETS,
  slippageBps,
  type DclPosition,
  type PositionQuote,
  type PullItem,
  type PullResult,
} from "../lib/dcl";
import { DCL_CONTRACT } from "../lib/config";
import { viewCall } from "../lib/near";

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
  lpResults,
  onRetryLiquidity,
  onDismissLp,
  onSetIntents,
  onSetLoofta,
  looftaReady,
}: {
  account: string;
  launches: LaunchedToken[] | null;
  busy: boolean;
  progress: string | null;
  onReload: () => void;
  onListOnRhea: (tokenIds: string[]) => void;
  /** Takes the sites down first, then (optionally) signs DCL remove_liquidity for `positions`. */
  onDelete: (tickers: string[], items: PullItem[]) => void;
  onRestore: (tickers: string[]) => void;
  /** Creator's removable / farmed DCL positions per tokenId (one view call). */
  loadPositions: (tokenIds: string[]) => Promise<Map<string, { removable: DclPosition[]; farmed: DclPosition[] }>>;
  notice: string | null;
  /** Per-position outcome of the last liquidity pull (withdrawn / slippage revert / failed / couldn't quote). */
  lpResults: PullResult[] | null;
  onRetryLiquidity: (items: PullItem[]) => void;
  onDismissLp: () => void;
  /** NEAR Intents widget on/off (and mode) for these tickers' pages. */
  onSetIntents: (tickers: string[], cfg: IntentsConfig) => void;
  /** Loofta widget on/off for these tickers' pages, optionally with a per-page payout target. */
  onSetLoofta: (tickers: string[], cfg: LooftaToggle) => void;
  /** Creator has a Loofta key or payout target (null = unknown). */
  looftaReady: boolean | null;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<VenueFilter>("all");
  const [sort, setSort] = useState<Sort>("new");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [confirmDel, setConfirmDel] = useState<LaunchedToken[] | null>(null);
  const [retryLp, setRetryLp] = useState<PullResult[] | null>(null);
  const [intentsMode, setIntentsMode] = useState<IntentsMode>("both");
  const [lftKind, setLftKind] = useState<LooftaTargetKind | "default">("default");
  const [lftTarget, setLftTarget] = useState("");

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
  const intentsAble = visibleSel.filter((l) => !l.deletedAt);
  const intentsCfg = (enabled: boolean, l?: LaunchedToken): IntentsConfig => ({ enabled, mode: l?.intents?.mode ?? intentsMode, tipAsset: l?.intents?.tipAsset ?? "usdc", ...(l?.intents?.recipient ? { recipient: l.intents.recipient } : {}) });

  /** Bulk Loofta payout target: "default" keeps each page's own setting; otherwise a validated per-page override. */
  const lftOverride = lftKind === "default" ? null : lftTarget.trim() ? payToFrom(lftKind, lftTarget) : { ok: false as const, error: "enter the payout target" };
  const looftaCfg = (enabled: boolean): LooftaToggle | null => {
    if (!enabled || lftKind === "default") return { enabled };
    return lftOverride?.ok ? { enabled, payTo: lftOverride.payTo } : null;
  };
  const looftaLabel = (l: LaunchedToken) => (l.loofta?.enabled ? (l.loofta.ready ? (l.loofta.custom ? "on · own target" : "on") : "on · not set up") : "off");

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {}
  };

  const exportCsv = () => {
    const cols = ["name", "ticker", "launched", "site", "contract", "contract_url", "launch_tx", "venue", "venue_url", "views", "near_intents", "loofta"];
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")].concat(
      visible.map((l) =>
        [l.name ?? "", l.ticker, new Date(l.createdAt).toISOString(), new URL(siteHref(l), location.origin).toString(), l.tokenId, l.explorerUrl, txUrl(l) ?? "", VENUE_LABEL[venueOf(l)], l.venueUrl ?? "", l.views ?? "", l.intents?.enabled ? l.intents.mode : "off", looftaLabel(l)]
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
            {intentsAble.length > 0 && (
              <span className="row intents-bulk">
                <select value={intentsMode} onChange={(e) => setIntentsMode(e.target.value as IntentsMode)} aria-label="NEAR Intents mode">
                  <option value="both">Intents: buy + tip</option>
                  <option value="buy">Intents: buy only</option>
                  <option value="tip">Intents: tips only</option>
                </select>
                <button className="mini" disabled={busy} onClick={() => onSetIntents(intentsAble.map((l) => l.ticker), intentsCfg(true))}>Enable NEAR Intents ({intentsAble.length})</button>
                <button className="ghost" disabled={busy} onClick={() => onSetIntents(intentsAble.map((l) => l.ticker), intentsCfg(false))}>Disable</button>
              </span>
            )}
            {intentsAble.length > 0 && (
              <span className="row intents-bulk loofta-bulk">
                <select value={lftKind} onChange={(e) => setLftKind(e.target.value as LooftaTargetKind | "default")} aria-label="Loofta payout target">
                  <option value="default">Loofta: my key / payout target</option>
                  {LOOFTA_TARGET_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>Loofta: pay to {k.label}…</option>
                  ))}
                </select>
                {lftKind !== "default" && (
                  <input className="loofta-target" value={lftTarget} onChange={(e) => setLftTarget(e.target.value)} placeholder={LOOFTA_TARGET_KINDS.find((k) => k.id === lftKind)?.placeholder} aria-label="Loofta payout target for these pages" maxLength={254} autoComplete="off" />
                )}
                <button
                  className="mini"
                  disabled={busy || !looftaCfg(true) || (lftKind === "default" && looftaReady === false)}
                  title={lftKind === "default" && looftaReady === false ? "Save your Loofta key or a payout target first (Studio → Loofta payments)" : undefined}
                  onClick={() => onSetLoofta(intentsAble.map((l) => l.ticker), looftaCfg(true)!)}
                >
                  Enable Loofta ({intentsAble.length})
                </button>
                <button className="ghost" disabled={busy} onClick={() => onSetLoofta(intentsAble.map((l) => l.ticker), { enabled: false })}>Disable</button>
                {lftKind !== "default" && lftTarget.trim() && lftOverride && !lftOverride.ok && <span className="error small">{lftOverride.error}</span>}
                {lftKind === "default" && looftaReady === false && (
                  <span className="muted small">Loofta isn't set up: save your Loofta key or a payout target in Studio → Loofta payments (or pick a payout target here).</span>
                )}
              </span>
            )}
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
        {lpResults && lpResults.some((r) => r.state !== "withdrawn") && (
          <PullReport results={lpResults} busy={busy} onRetry={(rs) => setRetryLp(rs)} onDismiss={onDismissLp} />
        )}
        {confirmDel && (
          <DeleteDialog
            tokens={confirmDel}
            loadPositions={loadPositions}
            onCancel={() => setConfirmDel(null)}
            onConfirm={(items) => {
              const t = confirmDel.map((l) => l.ticker);
              setConfirmDel(null);
              setSel(new Set());
              onDelete(t, items);
            }}
          />
        )}
        {retryLp && (
          <DeleteDialog
            tokens={everything.filter((l) => retryLp.some((r) => r.ticker === l.ticker))}
            retry={retryLp}
            loadPositions={loadPositions}
            onCancel={() => setRetryLp(null)}
            onConfirm={(items) => {
              setRetryLp(null);
              onRetryLiquidity(items);
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
                <th title="NEAR Intents widget on the token page: visitors buy or tip with any crypto. Always real NEAR mainnet payments.">Intents</th>
                <th title="Loofta 'pay the creator' button on the token page (needs your Loofta key or a payout target)">Loofta</th>
                <th className="c-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {launches === null ? (
                <tr><td colSpan={12} className="muted admin-empty">Loading…</td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={12} className="muted admin-empty">{all.length ? "Nothing matches." : "Nothing yeeted yet. Launch from the Studio tab."}</td></tr>
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
                      <td className="c-intents">
                        <label className="pick small" title={l.intents?.enabled ? `On: ${l.intents.mode === "both" ? "buy + tip" : l.intents.mode}` : "Off"}>
                          <input
                            type="checkbox"
                            checked={!!l.intents?.enabled}
                            disabled={busy || !!l.deletedAt}
                            onChange={(e) => onSetIntents([l.ticker], intentsCfg(e.target.checked, l))}
                            aria-label={`NEAR Intents for ${l.ticker}`}
                          />{" "}
                          {l.intents?.enabled ? (l.intents.mode === "both" ? "buy+tip" : l.intents.mode) : "off"}
                        </label>
                        {l.intents?.enabled && l.intentsState && (
                          <>
                            {!l.intentsState.tip && !l.intentsState.buy ? (
                              <span className="badge st-revoked" title={l.intentsState.notes.join(" ")}> hidden</span>
                            ) : l.intentsState.notes.length > 0 ? (
                              <span className="badge" title={l.intentsState.notes.join(" ")}> {l.intentsState.tip ? "tips only" : "buy only"}</span>
                            ) : null}
                            {l.intentsState.notes.map((n) => (
                              <span key={n} className="muted small intents-note" style={{ display: "block" }}>{n}</span>
                            ))}
                            {l.intents.mode !== "buy" && (
                              <button
                                className="mini ghost"
                                disabled={busy || !!l.deletedAt}
                                title="NEAR mainnet account that receives tips on this page (overrides your NEAR Intents tips payout account)"
                                onClick={() => {
                                  const v = prompt(`NEAR mainnet account for tips on $${l.ticker} (like you.near; never .testnet). Leave empty to use your default payout account.`, l.intents?.recipient ?? "");
                                  if (v === null) return;
                                  const a = v.trim().toLowerCase();
                                  if (a && !isMainnetAccount(a)) return alert("That isn't a NEAR mainnet account (use name.near or an implicit account, not .testnet).");
                                  const { recipient: _old, ...rest } = intentsCfg(true, l);
                                  onSetIntents([l.ticker], a ? { ...rest, recipient: a } : rest);
                                }}
                              >
                                {l.intentsState.recipient ? `tips → ${l.intentsState.recipient}` : "set tip account"}
                              </button>
                            )}
                          </>
                        )}
                      </td>
                      <td className="c-intents">
                        <label
                          className="pick small"
                          title={l.loofta?.enabled && !l.loofta.ready ? "On, but hidden: save your Loofta key or a payout target first" : looftaReady === false && !l.loofta?.custom ? "Set up Loofta first (Studio → Loofta payments)" : looftaLabel(l)}
                        >
                          <input
                            type="checkbox"
                            checked={!!l.loofta?.enabled}
                            disabled={busy || !!l.deletedAt || (!l.loofta?.enabled && looftaReady === false && !l.loofta?.custom)}
                            onChange={(e) => onSetLoofta([l.ticker], { enabled: e.target.checked })}
                            aria-label={`Loofta for ${l.ticker}`}
                          />{" "}
                          {looftaLabel(l)}
                        </label>
                      </td>
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

const STATE_LABEL: Record<PullResult["state"], string> = {
  withdrawn: "withdrawn",
  slippage: "price moved: reverted by the slippage check, nothing withdrawn",
  failed: "failed",
  unquoted: "skipped: couldn't quote",
  "not-signed": "not signed",
};

/** Per-position outcome of a liquidity pull, with "Retry with fresh prices" for the ones still in the pool. */
function PullReport({ results, busy, onRetry, onDismiss }: { results: PullResult[]; busy: boolean; onRetry: (r: PullResult[]) => void; onDismiss: () => void }) {
  const retryable = results.filter((r) => r.state !== "withdrawn");
  return (
    <div className="card lp-report" role="status">
      <strong>Rhea liquidity: {results.length - retryable.length}/{results.length} withdrawn.</strong> The page delete stands either way.
      <ul>
        {results.map((r) => (
          <li key={r.p.lpt_id} className={r.state === "withdrawn" ? "" : "lp-bad"}>
            ${r.ticker.toUpperCase()} position #{r.p.lpt_id.split("#")[1]}: {STATE_LABEL[r.state]}
            {r.txHash && <> · <a href={`${EXPLORER_BASE}/txns/${r.txHash}`} target="_blank" rel="noreferrer">tx ↗</a></>}
            {r.note && r.state !== "withdrawn" && <span className="muted small"> ({r.note})</span>}
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="danger" disabled={busy} onClick={() => onRetry(retryable)}>Retry with fresh prices ({retryable.length})</button>
        <button className="ghost" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

type Row = { ticker: string; p: DclPosition };

/**
 * Danger confirm: what Delete does and doesn't do, plus the optional Rhea liquidity withdrawal with slippage
 * protection (expected amounts from DCL predict_remove_liquidity, mins at the chosen slippage). With `retry`
 * it's liquidity-only for those positions (the pages are already down).
 */
function DeleteDialog({
  tokens,
  retry,
  loadPositions,
  onCancel,
  onConfirm,
}: {
  tokens: LaunchedToken[];
  retry?: PullResult[];
  loadPositions: (tokenIds: string[]) => Promise<Map<string, { removable: DclPosition[]; farmed: DclPosition[] }>>;
  onCancel: () => void;
  onConfirm: (items: PullItem[]) => void;
}) {
  const [pos, setPos] = useState<Row[] | null>(null);
  const [farmed, setFarmed] = useState(0);
  const [posErr, setPosErr] = useState<string | null>(null);
  const [pull, setPull] = useState(true);
  const [quotes, setQuotes] = useState<Map<string, PositionQuote> | null>(null);
  const [decimals, setDecimals] = useState<Map<string, number>>(new Map());
  const [slip, setSlip] = useState<string>(String(SLIPPAGE_DEFAULT));
  const [unq, setUnq] = useState<Map<string, "skip" | "unprotected">>(new Map());

  const quoteAll = async (rows: Row[]) => {
    setQuotes(null);
    const ids = [...new Set(rows.flatMap((r) => Object.values(poolTokens(r.p))))].filter((t) => !decimals.has(t));
    const [qs, ds] = await Promise.all([
      Promise.all(rows.map(async (r) => [r.p.lpt_id, await quotePosition(viewCall, DCL_CONTRACT, r.p)] as const)),
      Promise.all(ids.map(async (t) => [t, await viewCall<{ decimals: number }>(t, "ft_metadata").then((m) => m.decimals).catch(() => -1)] as const)),
    ]);
    setDecimals((d) => new Map([...d, ...ds]));
    setQuotes(new Map(qs));
  };
  useEffect(() => {
    loadPositions(tokens.map((t) => t.tokenId))
      .then((m) => {
        const list: Row[] = [];
        let f = 0;
        const only = retry ? new Set(retry.map((r) => r.p.lpt_id)) : null;
        for (const t of tokens) {
          const r = m.get(t.tokenId);
          for (const p of r?.removable ?? []) if (!only || only.has(p.lpt_id)) list.push({ ticker: t.ticker, p });
          f += r?.farmed.length ?? 0;
        }
        setPos(list);
        setFarmed(retry ? 0 : f);
        setPull(list.length > 0);
        if (list.length) void quoteAll(list);
      })
      .catch((e) => (setPos([]), setPosErr((e as Error).message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const n = tokens.length;
  const bps = slippageBps(Number(slip));
  const items: PullItem[] = !pull || !pos || !quotes || bps === null ? [] : pos.flatMap((r): PullItem[] => {
    const q = quotes.get(r.p.lpt_id);
    if (q?.ok) return [{ ...r, mode: "protect", bps }];
    return unq.get(r.p.lpt_id) === "unprotected" ? [{ ...r, mode: "unprotected" }] : [];
  });
  const approvals = Math.ceil(items.length / 10);
  const amt = (v: bigint, token: string) => {
    const d = decimals.get(token);
    return d === undefined || d < 0 ? `${v.toString()} base units` : fmtUnits(v, d);
  };
  const sym = (token: string) => (token.startsWith("wrap.") ? "wNEAR" : `$${token.split(".")[0].toUpperCase()}`);
  const both = (x: bigint, y: bigint, p: DclPosition) => {
    const t = poolTokens(p);
    return [x > 0n || y === 0n ? `${amt(x, t.x)} ${sym(t.x)}` : null, y > 0n ? `${amt(y, t.y)} ${sym(t.y)}` : null].filter(Boolean).join(" + ");
  };
  const waiting = pos === null || (pull && !!pos?.length && quotes === null);
  const nothing = retry ? items.length === 0 : false;

  return (
    <div className="danger-dialog" role="alertdialog" aria-modal="true" aria-labelledby="del-title">
      <div className="card danger-card">
        <h2 id="del-title">{retry ? "Retry liquidity withdrawal with fresh prices" : `Delete ${n === 1 ? `$${tokens[0].ticker.toUpperCase()}` : `${n} tokens`}?`}</h2>
        <ul className="del-facts">
          {!retry && (
            <>
              <li><strong>The token itself stays on the NEAR blockchain.</strong> Nobody can delete it; holders keep their tokens and it can still be traded wherever it's listed.</li>
              <li>The Yeetpad page{n > 1 ? "s" : ""} at <code>/t/…</code> go{n > 1 ? "" : "es"} offline (visitors see "taken down by its creator") and {n > 1 ? "they're" : "it's"} hidden from My tokens. You can restore {n > 1 ? "them" : "it"} later.</li>
            </>
          )}
          <li>
            {pos === null ? (
              <span className="muted">Checking your Rhea liquidity…</span>
            ) : pos.length === 0 ? (
              <span className="muted">{retry ? "Those positions are no longer in the pool (already withdrawn or gone)." : "No Rhea liquidity of yours to pull"}{posErr ? ` (couldn't check: ${posErr})` : ""}{retry ? "" : "."}</span>
            ) : retry ? (
              <strong>{pos.length} position{pos.length > 1 ? "s" : ""} still in the pool</strong>
            ) : (
              <label className="pick">
                <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} /> Also pull my liquidity from Rhea: {pos.length} position{pos.length > 1 ? "s" : ""}
              </label>
            )}
            {pull && pos && pos.length > 0 && (
              <div className="lp-quote">
                <div className="row slip-row">
                  <span className="small">Slippage tolerance:</span>
                  {SLIPPAGE_PRESETS.map((v) => (
                    <button key={v} className={`mini ${Number(slip) === v ? "is-on" : "ghost"}`} onClick={() => setSlip(String(v))}>{v}%</button>
                  ))}
                  <label className="small">
                    custom <input className="slip-input" type="number" min={SLIPPAGE_MIN} max={SLIPPAGE_MAX} step="0.1" value={slip} onChange={(e) => setSlip(e.target.value)} aria-label="custom slippage percent" /> %
                  </label>
                  <button className="link" onClick={() => void quoteAll(pos)} disabled={quotes === null}>refresh quotes</button>
                </div>
                {bps === null && <p className="error small">Slippage must be between {SLIPPAGE_MIN}% and {SLIPPAGE_MAX}%.</p>}
                <table className="admin-table lp-table">
                  <thead>
                    <tr><th>Position</th><th>You get now (expected)</th><th>Minimum{bps !== null ? ` (−${bps / 100}%)` : ""}</th></tr>
                  </thead>
                  <tbody>
                    {pos.map((r) => {
                      const q = quotes?.get(r.p.lpt_id);
                      return (
                        <tr key={r.p.lpt_id}>
                          <td>${r.ticker.toUpperCase()} #{r.p.lpt_id.split("#")[1]}</td>
                          {quotes === null ? (
                            <td colSpan={2} className="muted">quoting…</td>
                          ) : q?.ok ? (
                            <>
                              <td>{both(q.x, q.y, r.p)}</td>
                              <td>{bps === null ? "-" : (() => { const m = minsFor(q, bps); return both(m.x, m.y, r.p); })()}</td>
                            </>
                          ) : (
                            <td colSpan={2} className="lp-unq">
                              <span className="error small">Couldn't quote{q && !q.ok ? `: ${q.error}` : ""}.</span>{" "}
                              <select
                                aria-label={`what to do with position ${r.p.lpt_id}`}
                                value={unq.get(r.p.lpt_id) ?? "skip"}
                                onChange={(e) => setUnq((m) => new Map(m).set(r.p.lpt_id, e.target.value as "skip" | "unprotected"))}
                              >
                                <option value="skip">Skip this position</option>
                                <option value="unprotected">Withdraw without slippage protection</option>
                              </select>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="small muted">
                  Amounts are re-quoted from Rhea right before your wallet opens; if the price moves more than your tolerance before it lands, that withdrawal reverts (nothing lost but gas) and you can retry with fresh prices.
                  Your wallet signs one <code>remove_liquidity</code> per position ({items.length} transaction{items.length === 1 ? "" : "s"}, {approvals} wallet approval{approvals === 1 ? "" : "s"}, up to 10 each).
                  No deposit; gas only, at most ~{REMOVE_MAX_FEE_NEAR.toFixed(3)} NEAR per transaction (usually under 0.002, the rest is refunded).
                  The tokens and NEAR go straight back to your wallet; the pool stays on Rhea, empty of your liquidity.{retry ? "" : " This runs after the pages are taken down; if it fails or you reject it, the pages stay down."}
                </p>
              </div>
            )}
            {farmed > 0 && <p className="small muted">{farmed} position{farmed > 1 ? "s are" : " is"} staked in a farm; unstake on Rhea first to pull {farmed > 1 ? "them" : "it"}.</p>}
          </li>
        </ul>
        <div className="row">
          <button className="danger" disabled={waiting || (pull && !!pos?.length && bps === null) || nothing} onClick={() => onConfirm(items)}>
            {retry ? `Withdraw ${items.length}` : `Delete${items.length ? ` + pull ${items.length} position${items.length > 1 ? "s" : ""}` : ""}`}
          </button>
          <button className="ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

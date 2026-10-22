import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminAllowedItem, AdminResult, AdminWaitlistItem, WaitlistStatus } from "@osl/schema";
import { adminAction, adminWaitlist, type WaitlistCounts } from "../lib/api";
import AiKey from "./AiKey";

type Filter = "all" | WaitlistStatus;
type Action = "approve" | "revoke" | "remove";
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * Studio → Admin: waitlist requests with per-row and bulk Approve / Revoke / Remove, plus who is allowed.
 * `getToken` returns the admin's session token (asking the wallet to sign if needed; null = redirected).
 */
export default function Admin({ getToken, onAuthError }: { getToken: () => Promise<string | null>; onAuthError: (e: Error) => void }) {
  const [entries, setEntries] = useState<AdminWaitlistItem[] | null>(null);
  const [counts, setCounts] = useState<WaitlistCounts>({ total: 0, pending: 0, approved: 0, revoked: 0 });
  const [allowed, setAllowed] = useState<AdminAllowedItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState<Filter>("pending");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [manual, setManual] = useState("");

  const load = useCallback(async () => {
    setBusy("load");
    try {
      const token = await getToken();
      if (!token) return;
      const w = await adminWaitlist(token);
      setEntries(w.entries);
      setCounts(w.counts);
      setAllowed(w.allowed);
      setTruncated(w.truncated);
      setSel((s) => new Set([...s].filter((x) => w.entries.some((e) => e.account === x))));
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      onAuthError(e as Error);
    } finally {
      setBusy(null);
    }
  }, [getToken, onAuthError]);
  useEffect(() => void load(), [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (entries ?? []).filter(
      (e) => (filter === "all" || e.status === filter) && (!needle || e.account.includes(needle) || (e.contact ?? "").toLowerCase().includes(needle)),
    );
  }, [entries, filter, q]);
  const visibleSel = visible.filter((e) => sel.has(e.account));
  const allVisibleSelected = visible.length > 0 && visibleSel.length === visible.length;

  const act = async (action: Action, accounts: string[]) => {
    if (!accounts.length) return;
    if (action === "remove" && !confirm(`Remove ${accounts.length === 1 ? accounts[0] : `${accounts.length} requests`}? This revokes access and deletes the request.`)) return;
    setBusy(action);
    setMsg(null);
    try {
      const token = await getToken();
      if (!token) return;
      const { results } = await adminAction(action, accounts, token);
      const bad = results.filter((r: AdminResult) => !r.ok || r.note);
      const verb = { approve: "Approved", revoke: "Revoked", remove: "Removed" }[action];
      const ok = results.filter((r) => r.ok).length;
      setMsg({
        kind: bad.some((r) => !r.ok) ? "err" : "ok",
        text: `${verb} ${ok}/${results.length}.${bad.length ? " " + bad.map((r) => `${r.account}: ${r.note}`).join("; ") : ""}${action === "approve" ? " Live within ~30 s." : ""}`,
      });
      setSel(new Set());
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      onAuthError(e as Error);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (a: string, on: boolean) => setSel((s) => {
    const n = new Set(s);
    on ? n.add(a) : n.delete(a);
    return n;
  });
  const manualAcc = manual.trim().toLowerCase();
  const manualOk = manualAcc.length >= 2 && manualAcc.length <= 64 && ACCOUNT_RE.test(manualAcc);
  const disabled = busy !== null;
  const tabs: [Filter, string, number][] = [
    ["pending", "Pending", counts.pending],
    ["approved", "Approved", counts.approved],
    ["revoked", "Revoked", counts.revoked],
    ["all", "All", counts.total],
  ];

  return (
    <div className="admin">
      <AiKey scope="platform" getToken={getToken} onAuthError={onAuthError} />
      <section className="card admin-card">
        <div className="row between admin-head">
          <div>
            <h2>Whitelist requests</h2>
            <p className="muted small">Approve to let a wallet in (live within ~30 s, no redeploy). Remove = revoke access + delete the request.</p>
          </div>
          <div className="admin-stats" aria-label="counts">
            <span className="stat"><b>{counts.pending}</b> pending</span>
            <span className="stat stat-ok"><b>{counts.approved}</b> approved</span>
            <span className="stat"><b>{counts.total}</b> total</span>
          </div>
        </div>

        <div className="row between admin-tools">
          <div className="count-pick admin-filter" role="tablist" aria-label="filter">
            {tabs.map(([f, label, n]) => (
              <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {label} <span className="admin-n">{n}</span>
              </button>
            ))}
          </div>
          <div className="row">
            <input className="admin-search" placeholder="search account or contact" value={q} onChange={(e) => setQ(e.target.value)} aria-label="search" />
            <button className="ghost" disabled={disabled} onClick={load}>{busy === "load" ? "Loading…" : "↻ Refresh"}</button>
          </div>
        </div>

        <div className="row admin-bulk">
          <span className="small muted">{visibleSel.length} selected</span>
          <button disabled={disabled || !visibleSel.length} onClick={() => act("approve", visibleSel.map((e) => e.account))}>
            {busy === "approve" ? "Approving…" : `✓ Approve selected${visibleSel.length ? ` (${visibleSel.length})` : ""}`}
          </button>
          <button className="ghost" disabled={disabled || !visibleSel.length} onClick={() => act("revoke", visibleSel.map((e) => e.account))}>
            Revoke selected
          </button>
          <button className="ghost danger" disabled={disabled || !visibleSel.length} onClick={() => act("remove", visibleSel.map((e) => e.account))}>
            🗑 Remove selected
          </button>
        </div>
        {msg && <p className={msg.kind === "ok" ? "admin-msg" : "error"}>{msg.text}</p>}
        {truncated && <p className="error">List truncated (very large waitlist); showing the first 20,000.</p>}

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th className="c-check">
                  <input
                    type="checkbox"
                    aria-label="select all visible"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = visibleSel.length > 0 && !allVisibleSelected;
                    }}
                    onChange={(e) => setSel((s) => {
                      const n = new Set(s);
                      for (const v of visible) e.target.checked ? n.add(v.account) : n.delete(v.account);
                      return n;
                    })}
                  />
                </th>
                <th>Account</th>
                <th>Contact</th>
                <th>Joined</th>
                <th>Status</th>
                <th className="c-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries === null ? (
                <tr><td colSpan={6} className="muted admin-empty">Loading…</td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={6} className="muted admin-empty">{entries.length ? "Nothing matches this filter." : "No requests yet. Share the landing page! 📣"}</td></tr>
              ) : (
                visible.map((e) => (
                  <tr key={e.account} className={sel.has(e.account) ? "is-sel" : ""}>
                    <td className="c-check">
                      <input type="checkbox" aria-label={`select ${e.account}`} checked={sel.has(e.account)} onChange={(ev) => toggle(e.account, ev.target.checked)} />
                    </td>
                    <td className="c-acct"><code>{e.account}</code></td>
                    <td className="c-contact">{e.contact ?? <span className="muted">-</span>}</td>
                    <td className="c-when" title={new Date(e.joinedAt).toLocaleString()}>{fmt(e.joinedAt)}</td>
                    <td>
                      <span className={`badge st-${e.status}`}>{e.status}</span>
                      {e.status === "approved" && e.approvedBy && (
                        <span className="small muted admin-by" title={e.approvedAt ? new Date(e.approvedAt).toLocaleString() : ""}> by {e.approvedBy}</span>
                      )}
                    </td>
                    <td className="c-actions">
                      {e.status === "approved" ? (
                        <button className="ghost" disabled={disabled} onClick={() => act("revoke", [e.account])}>Revoke</button>
                      ) : (
                        <button className="mini" disabled={disabled} onClick={() => act("approve", [e.account])}>Approve</button>
                      )}
                      <button className="ghost danger" disabled={disabled} onClick={() => act("remove", [e.account])}>Remove</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card admin-card">
        <div className="row between">
          <h2>Who's allowed in</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (manualOk) act("approve", [manualAcc]).then(() => setManual(""));
            }}
          >
            <input placeholder="approve any account.testnet" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="account to approve" />
            <button className="mini" type="submit" disabled={disabled || !manualOk}>Approve</button>
          </form>
        </div>
        <ul className="admin-allowed">
          {allowed.map((a) => (
            <li key={a.account}>
              <code>{a.account}</code>
              <span className={`badge src-${a.source}`}>{a.source === "kv" ? "approved" : a.source === "env" ? "env var" : "admin"}</span>
              {a.approvedBy && <span className="small muted">by {a.approvedBy}{a.approvedAt ? `, ${fmt(a.approvedAt)}` : ""}</span>}
              {a.source === "kv" && (
                <button className="link" disabled={disabled} onClick={() => act("revoke", [a.account])}>revoke</button>
              )}
            </li>
          ))}
        </ul>
        <p className="muted small">Admins and env-var accounts live in <code>apps/orchestrator-api/wrangler.jsonc</code> (<code>bun run admin &lt;acct&gt;</code> + deploy).</p>
      </section>
    </div>
  );
}

function fmt(ms: number) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit" });
}

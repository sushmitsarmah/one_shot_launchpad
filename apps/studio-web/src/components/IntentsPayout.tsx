import { useCallback, useEffect, useState } from "react";
import type { IntentsSettings } from "@osl/schema";
import { getIntentsSettings, saveIntentsPayout } from "../lib/api";
import { isMainnetAccount } from "../lib/intents";

/**
 * "NEAR Intents tips": the creator's NEAR mainnet account that receives tips on all their pages. 1Click only runs on
 * NEAR mainnet, so tips are real mainnet payments on every deployment; a `.testnet` account can't receive them.
 * On mainnet deployments the creator's own account is the default; on testnet there is no default, so without
 * this (or a per-page recipient in My tokens) tips stay hidden.
 */
export default function IntentsPayout({
  getToken,
  onAuthError,
  onChange,
}: {
  getToken: () => Promise<string | null>;
  onAuthError?: (e: Error) => void;
  onChange?: (s: IntentsSettings | null) => void;
}) {
  const [s, setS] = useState<IntentsSettings | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const apply = useCallback((x: IntentsSettings | null) => (setS(x), onChange?.(x)), [onChange]);

  useEffect(() => {
    void (async () => {
      const token = await getToken().catch(() => null);
      if (!token) return;
      try {
        apply(await getIntentsSettings(token));
      } catch (e) {
        setMsg({ kind: "err", text: (e as Error).message });
        onAuthError?.(e as Error);
      }
    })();
  }, [getToken, apply, onAuthError]);

  const clean = account.trim().toLowerCase();
  const ok = isMainnetAccount(clean);
  const save = async (value: string | null) => {
    setBusy(true);
    setMsg(null);
    try {
      const token = await getToken();
      if (!token) return;
      const r = await saveIntentsPayout(value, token);
      apply(r);
      setAccount("");
      setMsg({ kind: "ok", text: value ? `Tips go to ${r.payout} on NEAR mainnet.` : "Payout account removed." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      onAuthError?.(e as Error);
    } finally {
      setBusy(false);
    }
  };

  const status =
    s === undefined ? (
      <span className="muted">Loading…</span>
    ) : !s ? null : s.tipRecipient ? (
      <>
        Tips go to <strong>{s.tipRecipient}</strong> on NEAR mainnet{s.payout ? "" : " (your account, by default)"}.
      </>
    ) : (
      <>Not set up · tips are hidden on your pages: NEAR Intents pays out on NEAR mainnet, and your {s.network} account can't receive there.</>
    );

  return (
    <section className="card aikey intents-payout run-full">
      <div className="row between">
        <div>
          <h2>NEAR Intents tips</h2>
          <p className="small aikey-status">{status}</p>
        </div>
        <button className="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : s?.payout ? "Manage" : "Set payout account"}
        </button>
      </div>
      {msg && <p className={`small ${msg.kind === "ok" ? "ok" : "error"}`}>{msg.text}</p>}
      {open && s && (
        <>
          <p className="muted small">
            Visitors tip you in any crypto through <a href="https://near-intents.org" target="_blank" rel="noreferrer">NEAR Intents</a>; you receive USDC
            (or wNEAR) on <strong>NEAR mainnet</strong>. These are real payments on every Yeetpad network, so the account must exist on mainnet:
            {" "}<code>name.near</code> or an implicit account, never a <code>.testnet</code> name. A per-page recipient in My tokens overrides this.
          </p>
          {s.payout && (
            <div className="row">
              <span className="small">
                Payout account <strong>{s.payout}</strong>
              </span>
              <button className="ghost" disabled={busy} onClick={() => void save(null)}>Remove</button>
            </div>
          )}
          <div className="row">
            <input
              className="aikey-input"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              placeholder="you.near"
              aria-label="NEAR mainnet payout account"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
            <button disabled={busy || !ok} onClick={() => void save(clean)}>{busy ? "Saving…" : s.payout ? "Replace" : "Save"}</button>
          </div>
          {clean && !ok && <p className="error small">Enter a NEAR mainnet account like you.near (not .testnet).</p>}
        </>
      )}
    </section>
  );
}

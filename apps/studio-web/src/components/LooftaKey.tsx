import { useCallback, useEffect, useState } from "react";
import { LOOFTA_SOCIALS, LOOFTA_SOCIAL_LABEL, LooftaPayTo, type LooftaSettings, type LooftaSocial } from "@osl/schema";
import { deleteLooftaKey, getLooftaSettings, saveLooftaKey, saveLooftaPayTo, testLooftaKey } from "../lib/api";

type Kind = "email" | LooftaSocial | "username";
const KINDS: { id: Kind; label: string; placeholder: string }[] = [
  { id: "email", label: "Email", placeholder: "you@example.com" },
  ...LOOFTA_SOCIALS.map((p) => ({ id: p as Kind, label: LOOFTA_SOCIAL_LABEL[p], placeholder: "@handle" })),
  { id: "username", label: "Loofta username", placeholder: "@username" },
];
/** Builds a payout target from the picker + text (shared with My tokens' per-page override). */
export function payToFrom(kind: Kind, value: string): { ok: true; payTo: LooftaPayTo } | { ok: false; error: string } {
  const raw = kind === "email" ? { kind, value } : kind === "username" ? { kind, value } : { kind: "social", platform: kind, value };
  const r = LooftaPayTo.safeParse(raw);
  return r.success ? { ok: true, payTo: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "invalid payout target" };
}
export { KINDS as LOOFTA_TARGET_KINDS, type Kind as LooftaTargetKind };

/**
 * "Loofta" settings, next to the AI key: the creator's own Loofta API key (optional; write-only, encrypted on the
 * server, only the last 4 shown) and/or a payout target for the keyless route. A page's Loofta toggle only works
 * once one of the two is saved.
 */
export default function LooftaKey({
  getToken,
  onAuthError,
  onChange,
}: {
  getToken: () => Promise<string | null>;
  onAuthError?: (e: Error) => void;
  onChange?: (s: LooftaSettings | null) => void;
}) {
  const [s, setS] = useState<LooftaSettings | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [kind, setKind] = useState<Kind>("twitter");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const apply = useCallback((x: LooftaSettings | null) => (setS(x), onChange?.(x)), [onChange]);
  const act = async (name: string, fn: (token: string) => Promise<void>) => {
    setBusy(name);
    setMsg(null);
    try {
      const token = await getToken();
      if (!token) return;
      await fn(token);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      onAuthError?.(e as Error);
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    void (async () => {
      const token = await getToken().catch(() => null);
      if (!token) return;
      try {
        apply(await getLooftaSettings(token));
      } catch (e) {
        setMsg({ kind: "err", text: (e as Error).message });
        onAuthError?.(e as Error);
      }
    })();
  }, [getToken, apply, onAuthError]);

  const cleanKey = apiKey.trim();
  const keyOk = /^lft_[A-Za-z0-9_-]{8,256}$/.test(cleanKey);
  const pt = target.trim() ? payToFrom(kind, target) : null;
  const disabled = busy !== null;

  const saveKey = () =>
    act("key", async (token) => {
      const r = await saveLooftaKey(cleanKey, token);
      setApiKey("");
      apply(r);
      setMsg({ kind: "ok", text: `Loofta key saved and checked · …${r.key?.last4 ?? "????"}` });
    });
  const test = () =>
    act("test", async (token) => {
      const r = await testLooftaKey(token);
      apply(r);
      setMsg(r.ok ? { kind: "ok", text: "Loofta accepted the key." } : { kind: "err", text: r.error ?? "Key check failed." });
    });
  const removeKey = () => {
    if (!confirm("Delete your Loofta key? Pages fall back to your payout target, or hide the Loofta widget if you have none.")) return;
    act("delkey", async (token) => {
      apply(await deleteLooftaKey(token));
      setMsg({ kind: "ok", text: "Loofta key deleted." });
    });
  };
  const savePayTo = () =>
    act("payto", async (token) => {
      if (!pt?.ok) return;
      const r = await saveLooftaPayTo(pt.payTo, token);
      setTarget("");
      apply(r);
      setMsg({ kind: "ok", text: `Payout target saved: ${r.payTo?.display}` });
    });
  const clearPayTo = () =>
    act("delpay", async (token) => {
      apply(await saveLooftaPayTo(null, token));
      setMsg({ kind: "ok", text: "Payout target removed." });
    });

  const status =
    s === undefined ? (
      <span className="muted">Loading…</span>
    ) : !s ? null : s.route === "checkout" ? (
      <>
        Ready · pages use a Loofta checkout on <strong>your Loofta account</strong> (key …{s.key?.last4 ?? "????"}) <span className="badge badge-ok">✓ valid</span>
      </>
    ) : s.route === "send" ? (
      <>
        Ready · pages open Loofta Send to <strong>{s.payTo?.display}</strong>
        {s.key && !s.key.valid && <span className="badge st-revoked"> key not working</span>}
      </>
    ) : (
      <>Not set up · the Loofta toggle on your pages stays off until you save a Loofta key or a payout target.</>
    );

  return (
    <section className="card aikey loofta-key run-full">
      <div className="row between">
        <div>
          <h2>Loofta payments</h2>
          <p className="small aikey-status">{status}</p>
        </div>
        <button className="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : s?.route ? "Manage" : "Set up Loofta"}
        </button>
      </div>
      {s && !s.enabled && <p className="error small">Saving Loofta settings isn't enabled on this server yet (KEY_ENCRYPTION_KEY missing).</p>}
      {msg && <p className={`small ${msg.kind === "ok" ? "ok" : "error"}`}>{msg.text}</p>}
      {open && s?.enabled && (
        <>
          <p className="muted small">
            <a href="https://loofta.com" target="_blank" rel="noreferrer">Loofta</a> lets visitors pay you with any token on any chain; you receive USDC
            and can cash out to Venmo, Cash App, Revolut or Zelle. Payers pay Loofta's fees, you receive the amount. Turn it on per page in My tokens or before
            launch. <strong>Payments are real on every Yeetpad network, testnet included: Loofta has no test mode.</strong>
          </p>

          <h3 className="small">1 · Payout target (no key needed)</h3>
          {s.payTo ? (
            <div className="row">
              <span className="small">
                Paying <strong>{s.payTo.display}</strong>
              </span>
              <button className="ghost" disabled={disabled} onClick={clearPayTo}>Remove</button>
            </div>
          ) : null}
          <div className="row">
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="payout target type" disabled={disabled}>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
            <input
              className="aikey-input"
              autoComplete="off"
              spellCheck={false}
              maxLength={254}
              placeholder={KINDS.find((k) => k.id === kind)?.placeholder}
              aria-label="payout target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <button disabled={disabled || !pt?.ok} onClick={savePayTo}>{busy === "payto" ? "Saving…" : s.payTo ? "Replace" : "Save"}</button>
          </div>
          {pt && !pt.ok && <p className="error small">{pt.error}</p>}
          <p className="muted small">
            Opens Loofta's Send page with this recipient filled in. It's stored encrypted and never put in your page's HTML or config; visitors only see
            {" "}"@handle on X" or, for an email, "the creator (by email)". The payer sees the recipient on Loofta's page after clicking, and pays with a
            Solana wallet as a guest (email/social) or after signing in to Loofta (username). Recipients claim with that email or account on Loofta.
            Solana wallet addresses aren't supported: Loofta's links can't prefill them.
          </p>

          <h3 className="small">2 · Your Loofta API key (optional, recommended)</h3>
          {s.key && (
            <div className="row">
              <span className="small">
                Key …{s.key.last4 ?? "????"} {s.key.valid ? <span className="badge badge-ok">✓ valid</span> : <span className="badge st-revoked">not working</span>}
                {s.key.lastError && <span className="muted"> · {s.key.lastError}</span>}
              </span>
              <button className="ghost" disabled={disabled} onClick={test}>{busy === "test" ? "Testing…" : "Test"}</button>
              <button className="ghost danger" disabled={disabled} onClick={removeKey}>Delete</button>
            </div>
          )}
          <div className="row">
            <input
              className="aikey-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={300}
              placeholder="lft_live_…"
              aria-label="Loofta API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button disabled={disabled || !keyOk} onClick={saveKey}>{busy === "key" ? "Checking…" : s.key ? "Replace key" : "Save & check"}</button>
          </div>
          <p className="muted small">
            With a key, each payment gets its own Loofta checkout link paying your Loofta account: no recipient shown to anyone, any token on any chain, no
            Loofta sign-in for payers. Create it in Loofta (pay.loofta.com → API key &amp; branding, scope <code>payment_links:create</code>). It's checked
            with a harmless lookup, stored encrypted (AES-256-GCM) on the server and never shown again, only its last 4 characters; it is only ever sent to
            {" "}<code>api.loofta.com</code>. A key takes priority over the payout target. Loofta keys are live: there is no sandbox.
          </p>
        </>
      )}
    </section>
  );
}

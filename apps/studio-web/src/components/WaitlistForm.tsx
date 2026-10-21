import { useEffect, useRef, useState } from "react";
import { CONTACT_MAX, accountError, contactError, joinWaitlist } from "../lib/waitlist";
import "../styles/waitlist.css";

/** Whitelist signup form: NEAR account + optional contact, with a success state. */
export function WaitlistForm({ initialAccount = "", autoFocus = false }: { initialAccount?: string; autoFocus?: boolean }) {
  const [account, setAccount] = useState(initialAccount);
  const [contact, setContact] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ account: string; already: boolean } | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) first.current?.focus();
  }, [autoFocus]);

  const aErr = accountError(account);
  const cErr = contactError(contact);

  if (done) {
    return (
      <div className="wl-done" role="status">
        <span className="wl-done-emoji" aria-hidden="true">🎟️</span>
        <h3>{done.already ? "Still on the list!" : "You're on the list!"}</h3>
        <p>
          <b>{done.account}</b> {done.already ? "was already in the queue. No need to yeet twice." : "is in the queue."} We'll open the
          doors in small batches. Keep your wallet warm.
        </p>
      </div>
    );
  }

  return (
    <form
      className="wl-form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setTouched(true);
        if (aErr || cErr) return;
        setBusy(true);
        setErr(null);
        try {
          const r = await joinWaitlist(account, contact);
          setDone({ account: r.account, already: r.already });
        } catch (e) {
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        <span>Your NEAR account</span>
        <input
          ref={first}
          value={account}
          placeholder="yeeter.testnet"
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
          maxLength={64}
          onChange={(e) => setAccount(e.target.value)}
          aria-invalid={touched && !!aErr}
        />
        {touched && aErr && <small className="wl-err">{aErr}</small>}
      </label>
      <label>
        <span>
          Email or @handle <i>(optional, so we can ping you)</i>
        </span>
        <input
          value={contact}
          placeholder="you@mail.com or @you"
          spellCheck={false}
          autoCapitalize="none"
          maxLength={CONTACT_MAX}
          onChange={(e) => setContact(e.target.value)}
          aria-invalid={touched && !!cErr}
        />
        {touched && cErr && <small className="wl-err">{cErr}</small>}
      </label>
      <button className="btn btn-pink wl-submit" type="submit" disabled={busy}>
        {busy ? "Saving your spot…" : "Get me on the list"} <span aria-hidden="true">🎟️</span>
      </button>
      {err && <p className="wl-err wl-err-box">{err}</p>}
    </form>
  );
}

/** Landing-page CTA: a big button that opens the form in a sticker-style dialog. */
export default function WaitlistCta({ label = "Join the whitelist", className = "btn btn-lg" }: { label?: string; className?: string }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const show = () => {
    setOpen(true);
    dlg.current?.showModal();
  };
  const close = () => {
    dlg.current?.close();
  };
  return (
    <>
      <button type="button" className={className} onClick={show}>
        {label} <span className="arrow" aria-hidden="true">→</span>
      </button>
      <dialog
        ref={dlg}
        className="wl-dialog"
        aria-labelledby="wl-title"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dlg.current) close(); // backdrop click
        }}
      >
        <div className="wl-card">
          <button type="button" className="wl-x" aria-label="Close" onClick={close}>
            ✕
          </button>
          <span className="pill wl-pill">🔒 Invite-only beta</span>
          <h2 id="wl-title">Get on the whitelist</h2>
          <p className="wl-sub">The factory is warming up. Drop your NEAR account and we'll let you in as we open the doors.</p>
          {open && <WaitlistForm autoFocus />}
        </div>
      </dialog>
    </>
  );
}

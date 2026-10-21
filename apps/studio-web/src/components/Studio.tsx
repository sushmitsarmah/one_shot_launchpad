import { useCallback, useEffect, useState } from "react";
import { formatNear, parseNear, type LaunchIdea, type LaunchResponse, type SessionResponse } from "@osl/schema";
import "@near-wallet-selector/modal-ui/styles.css";
import { initWallet, depositCredits, signOut } from "../lib/wallet";
import { getVaultBalance } from "../lib/near";
import { generate, launch, UnauthorizedError } from "../lib/api";
import { clearSession, completeRedirectSignIn, ensureSession, getSession } from "../lib/auth";
import { VAULT_CONTRACT } from "../lib/config";

type Busy = null | "deposit" | "generate" | "launch" | "verify";

export default function Studio() {
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [prompt, setPrompt] = useState("");
  const [idea, setIdea] = useState<LaunchIdea | null>(null);
  const [result, setResult] = useState<LaunchResponse | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);

  // Finish a redirect-style signMessage (MyNearWallet returning to /app/ with the signature in the URL).
  useEffect(() => {
    completeRedirectSignIn()
      .then((s) => s && setSession(s))
      .catch((e) => setError((e as Error).message));
  }, []);

  // Session belongs to one account: drop it when the wallet account changes.
  useEffect(() => {
    if (!account) return setSession(null);
    const s = getSession(account);
    if (!s) {
      try {
        const stored = JSON.parse(localStorage.getItem("osl.session") ?? "null");
        if (stored && stored.accountId !== account) clearSession();
      } catch {}
    }
    setSession(s);
  }, [account]);

  /** Returns a bearer token, prompting the wallet to sign if needed (null = redirected away). */
  const authToken = async (acc: string) => {
    const s = getSession(acc) ?? (await ensureSession(acc));
    setSession(s);
    return s?.token ?? null;
  };

  useEffect(() => {
    let sub: { unsubscribe(): void } | undefined;
    initWallet()
      .then(({ selector }) => {
        const pick = () => selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
        setAccount(pick());
        sub = selector.store.observable.subscribe(() => setAccount(pick()));
      })
      .catch((e) => setError(`wallet init failed: ${e.message ?? e}`));
    return () => sub?.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    if (!account) return setBalance(null);
    try {
      setBalance(await getVaultBalance(account));
    } catch (e) {
      setBalance(null);
      setError(`balance view failed: ${(e as Error).message}`);
    }
  }, [account]);
  useEffect(() => void refresh(), [refresh]);

  const run = async (kind: Busy, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof UnauthorizedError) setSession(null);
      setError((e as Error).message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => (await initWallet()).modal.show();

  if (!account) {
    return (
      <section className="card center">
        <h2>1. Connect your NEAR wallet</h2>
        <p className="muted">Testnet only. MyNearWallet, Meteor or HERE.</p>
        <button onClick={connect}>Connect wallet</button>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <div className="row between">
          <div>
            <div className="muted small">Connected</div>
            <strong>{account}</strong>{" "}
            {session ? (
              <span className="badge badge-ok" title={`Session valid until ${new Date(session.expiresAt).toLocaleString()}`}>✓ verified</span>
            ) : (
              <span className="badge">not verified</span>
            )}
          </div>
          <div className="row">
            {!session && (
              <button
                disabled={busy !== null}
                onClick={() => run("verify", async () => void (await authToken(account)))}
              >
                {busy === "verify" ? "Sign in wallet…" : "Verify wallet"}
              </button>
            )}
            <button className="ghost" onClick={() => signOut().then(() => setSession(null))}>Sign out</button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>2. Top up NEAR AI credits</h2>
        <p>
          Vault balance: <strong>{balance === null ? "…" : `${formatNear(balance)} NEAR`}</strong>{" "}
          <button className="link" onClick={refresh}>refresh</button>
        </p>
        <div className="row">
          <input type="number" min="0.01" step="0.1" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <span>NEAR</span>
          <button
            disabled={busy !== null}
            onClick={() =>
              run("deposit", async () => {
                await depositCredits(parseNear(amount));
                await refresh();
              })
            }
          >
            {busy === "deposit" ? "Confirm in wallet…" : "Top up"}
          </button>
        </div>
        <p className="muted small">Calls <code>deposit_credits</code> on <code>{VAULT_CONTRACT}</code>. Unused credits can be withdrawn.</p>
      </section>

      <section className="card">
        <h2>3. Generate an idea</h2>
        {!session && (
          <p className="muted small">
            First time this session? Your wallet will ask you to sign a short message (free, no transaction) so the API knows it's really you.
          </p>
        )}
        <textarea
          rows={3}
          placeholder="e.g. a wholesome meme coin for sleepy penguins"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button
          disabled={busy !== null || prompt.trim().length < 3}
          onClick={() =>
            run("generate", async () => {
              const token = await authToken(account);
              if (!token) return;
              const r = await generate(prompt.trim(), account, token);
              setIdea(r.idea);
              setResult(null);
              await refresh();
            })
          }
        >
          {busy === "generate" ? "Thinking…" : "Generate"}
        </button>

        {idea && <IdeaCard idea={idea} onTicker={(ticker) => setIdea({ ...idea, ticker })} />}
      </section>

      {idea && (
        <section className="card">
          <h2>4. Launch</h2>
          <p className="muted small">
            Creates a NEP-141 token <code>{idea.ticker}.&lt;factory&gt;</code> owned by you, paid from your vault balance.
          </p>
          <button
            disabled={busy !== null}
            onClick={() =>
              run("launch", async () => {
                const token = await authToken(account);
                if (!token) return;
                setResult(await launch(account, idea, token));
                await refresh();
              })
            }
          >
            {busy === "launch" ? "Launching…" : "Launch token"}
          </button>
          {result && (
            <div className="result">
              <p>
                Token: <code>{result.tokenId}</code>
              </p>
              <p>
                <a href={result.explorerUrl} target="_blank" rel="noreferrer">View transaction on explorer ↗</a>
              </p>
              <details open>
                <summary>Generated site config</summary>
                <pre>{JSON.stringify(result.siteConfig, null, 2)}</pre>
              </details>
            </div>
          )}
        </section>
      )}

      {error && <p className="error">{error}</p>}
    </>
  );
}

function IdeaCard({ idea, onTicker }: { idea: LaunchIdea; onTicker: (t: string) => void }) {
  const c = idea.colors;
  return (
    <div className="idea" style={{ background: c.background, color: c.text, borderColor: c.primary }}>
      <div className="row between">
        <h3 style={{ color: c.primary }}>{idea.name}</h3>
        <label className="ticker" style={{ background: c.accent, color: c.background }}>
          $
          <input
            value={idea.ticker}
            onChange={(e) => onTicker(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16))}
            aria-label="ticker"
          />
        </label>
      </div>
      <p style={{ color: c.secondary }}><em>{idea.tagline}</em></p>
      <p>{idea.description}</p>
      <div className="swatches">
        {Object.entries(c).map(([k, v]) => (
          <span key={k} title={`${k} ${v}`} style={{ background: v }} />
        ))}
      </div>
    </div>
  );
}

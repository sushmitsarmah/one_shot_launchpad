import { useCallback, useEffect, useState } from "react";
import { formatNear, parseNear, MAX_BATCH, type BatchLaunchResponse, type LaunchedToken, type LaunchIdea, type SessionResponse } from "@osl/schema";
import "@near-wallet-selector/modal-ui/styles.css";
import { initWallet, depositCredits, signOut } from "../lib/wallet";
import { getVaultBalance } from "../lib/near";
import { generate, launchBatch, myLaunches, UnauthorizedError } from "../lib/api";
import { clearSession, completeRedirectSignIn, ensureSession, getSession } from "../lib/auth";
import { VAULT_CONTRACT } from "../lib/config";

type Busy = null | "deposit" | "generate" | "launch" | "verify";

export default function Studio() {
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(1);
  const [ideas, setIdeas] = useState<LaunchIdea[]>([]);
  const [picked, setPicked] = useState<boolean[]>([]);
  const [result, setResult] = useState<BatchLaunchResponse | null>(null);
  const [launches, setLaunches] = useState<LaunchedToken[] | null>(null);
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

  const loadLaunches = useCallback(async () => {
    if (!account) return setLaunches(null);
    try {
      setLaunches((await myLaunches(account)).launches);
    } catch {
      setLaunches([]);
    }
  }, [account]);
  useEffect(() => void loadLaunches(), [loadLaunches]);

  const chosen = ideas.filter((_, i) => picked[i]);

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
            <div className="muted small">1. Wallet connected</div>
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
        <h2>3. Generate ideas</h2>
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
        <div className="row">
          <span className="muted small">How many?</span>
          <div className="count-pick" role="radiogroup" aria-label="number of ideas">
            {Array.from({ length: MAX_BATCH }, (_, i) => i + 1).map((n) => (
              <button key={n} role="radio" aria-checked={count === n} className={count === n ? "on" : ""} onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
          </div>
          <button
            disabled={busy !== null || prompt.trim().length < 3}
            onClick={() =>
              run("generate", async () => {
                const token = await authToken(account);
                if (!token) return;
                const r = await generate(prompt.trim(), account, token, count);
                const list = r.ideas ?? [r.idea];
                setIdeas(list);
                setPicked(list.map(() => true));
                setResult(null);
                await refresh();
              })
            }
          >
            {busy === "generate" ? "Thinking…" : count > 1 ? `Generate ${count}` : "Generate"}
          </button>
        </div>

        {ideas.map((idea, i) => (
          <IdeaCard
            key={i}
            idea={idea}
            picked={ideas.length > 1 ? picked[i] : undefined}
            onPick={(v) => setPicked(picked.map((p, j) => (j === i ? v : p)))}
            onTicker={(ticker) => setIdeas(ideas.map((x, j) => (j === i ? { ...x, ticker } : x)))}
          />
        ))}
      </section>

      {ideas.length > 0 && (
        <section className="card">
          <h2>4. Yeet it</h2>
          <p className="muted small">
            Creates {chosen.length === 1 ? "a NEP-141 token" : `${chosen.length} NEP-141 tokens in one transaction`} owned by you, paid from your vault balance
            (~1.82 NEAR each; a failed item is refunded). Each gets a site at <code>/t/&lt;token-name&gt;</code>.
          </p>
          <button
            disabled={busy !== null || chosen.length === 0}
            onClick={() =>
              run("launch", async () => {
                const token = await authToken(account);
                if (!token) return;
                setResult(await launchBatch(account, chosen, token));
                await refresh();
                await loadLaunches();
              })
            }
          >
            {busy === "launch" ? "Launching…" : chosen.length > 1 ? `Launch ${chosen.length} tokens` : "Launch token"}
          </button>
          {result && (
            <div className="result">
              <ul className="launch-results">
                {result.results.map((r) => (
                  <li key={r.ticker}>
                    {r.ok ? "✅" : "❌"} <strong>${r.ticker.toUpperCase()}</strong>{" "}
                    {r.ok ? (
                      <>
                        <code>{r.tokenId}</code> · <a href={`/t/${r.slug ?? r.ticker}`}>open site →</a>
                      </>
                    ) : (
                      <span className="muted">{r.error}</span>
                    )}
                  </li>
                ))}
              </ul>
              <p>
                <a href={result.explorerUrl} target="_blank" rel="noreferrer">View transaction on explorer ↗</a>
              </p>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <div className="row between">
          <h2>My launches</h2>
          <button className="link" onClick={loadLaunches}>refresh</button>
        </div>
        {launches === null ? (
          <p className="muted">Loading…</p>
        ) : launches.length === 0 ? (
          <p className="muted">Nothing yeeted yet. Your tokens will show up here.</p>
        ) : (
          <ul className="my-launches">
            {launches.map((l) => (
              <li key={l.ticker}>
                <span className="dot" style={{ background: l.colors?.primary ?? "var(--pink)" }} />
                <a href={`/t/${l.slug ?? l.ticker}`}>
                  <strong>{l.name ?? l.ticker.toUpperCase()}</strong> <span className="muted">${l.ticker.toUpperCase()}</span>
                </a>
                <span className="muted small">{new Date(l.createdAt).toLocaleDateString()}</span>
                <a className="small" href={l.explorerUrl} target="_blank" rel="noreferrer">explorer ↗</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </>
  );
}

/** True if `fg` has enough contrast on `bg` (WCAG ratio >= 3, fine for large headings). */
function readable(fg: string, bg: string) {
  const lum = (hex: string) => {
    let h = hex.replace("#", "");
    if (h.length === 3) h = [...h].map((x) => x + x).join("");
    const [r, g, b] = [0, 2, 4].map((i) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(fg), lum(bg)];
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 3;
}

function IdeaCard({
  idea,
  onTicker,
  picked,
  onPick,
}: {
  idea: LaunchIdea;
  onTicker: (t: string) => void;
  picked?: boolean;
  onPick: (v: boolean) => void;
}) {
  const c = idea.colors;
  return (
    <div className="idea" style={{ background: c.background, color: c.text, borderColor: c.primary, opacity: picked === false ? 0.55 : 1 }}>
      <div className="row between">
        {picked !== undefined && (
          <label className="pick small">
            <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} /> launch
          </label>
        )}
        <h3 style={{ color: readable(c.primary, c.background) ? c.primary : c.text }}>{idea.name}</h3>
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

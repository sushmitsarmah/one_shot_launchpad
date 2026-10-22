import { useCallback, useEffect, useState } from "react";
import { formatNear, parseNear, MAX_BATCH, type BatchLaunchResponse, type LaunchedToken, type LaunchIdea, type QuoteResponse, type SessionResponse } from "@osl/schema";
import "@near-wallet-selector/modal-ui/styles.css";
import { initWallet, depositCredits, friendlyWalletError, sendForRelist, signCallsInChunks, signOut, takeRedirectedNearly, takeRedirectedRelist } from "../lib/wallet";
import { viewCall } from "../lib/near";
import { getVaultBalance } from "../lib/near";
import { appLocked, generate, justhootFinalize, justhootPrepare, launchBatch, listOnRhea, me, myLaunches, nearlyFinalize, nearlyPrepare, quote, saveSiteSettings, UnauthorizedError, venueStatus, type ListOnChoice } from "../lib/api";
import { webpIcons } from "../lib/icon";
import { EXPLORER_BASE, NETWORK } from "../lib/config";
import { NotWhitelistedError, clearSession, completeRedirectSignIn, ensureSession, getSession } from "../lib/auth";
import { WaitlistForm } from "./WaitlistForm";
import Admin from "./Admin";
import { VAULT_CONTRACT } from "../lib/config";

type Busy = null | "deposit" | "generate" | "launch" | "verify" | "settings" | "relist";

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
  const [openSettings, setOpenSettings] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  /** null = still asking the API; assume locked until it says otherwise. */
  const [locked, setLocked] = useState<boolean | null>(null);
  const [notWhitelisted, setNotWhitelisted] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [listOn, setListOn] = useState<ListOnChoice>("none");
  const [fdv, setFdv] = useState("1000");
  const [creatorPct, setCreatorPct] = useState("0");
  const [q, setQ] = useState<QuoteResponse | null>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [nearlyOff, setNearlyOff] = useState<string | null>(null);
  const [justhootOff, setJusthootOff] = useState<string | null>("mainnet only, enabled at mainnet launch");
  useEffect(() => {
    venueStatus(account).then((v) => {
      setNearlyOff(v.nearly.enabled ? null : v.nearly.reason);
      setJusthootOff(v.justhoot.enabled ? null : v.justhoot.reason);
    });
  }, [account]);
  const [tab, setTab] = useState<"studio" | "admin">(() => (typeof location !== "undefined" && location.hash === "#admin" ? "admin" : "studio"));
  const openTab = (t: "studio" | "admin") => {
    setTab(t);
    history.replaceState(null, "", t === "admin" ? "#admin" : location.pathname + location.search);
  };

  // The Admin tab only exists for ADMIN_ACCOUNTS (the API enforces it too).
  useEffect(() => {
    if (!session) return setIsAdmin(false);
    let live = true;
    me(session.token)
      .then((r) => live && setIsAdmin(r.isAdmin))
      .catch(() => live && setIsAdmin(false));
    return () => {
      live = false;
    };
  }, [session?.token]);

  useEffect(() => {
    appLocked().then(setLocked);
  }, []);

  // Finish a redirect-style signMessage (MyNearWallet returning to /app/ with the signature in the URL).
  useEffect(() => {
    completeRedirectSignIn()
      .then((s) => s && setSession(s))
      .catch((e) => (e instanceof NotWhitelistedError ? setNotWhitelisted(true) : setError((e as Error).message)));
  }, []);

  // Session belongs to one account: drop it when the wallet account changes.
  useEffect(() => {
    setNotWhitelisted(false);
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
  const rheaOpts = { openingFdvNear: Number(fdv) || 1000, creatorPct: Math.min(90, Math.max(0, Number(creatorPct) || 0)) };

  // Cost estimate from the venue's quote views (only with a live session; never prompts the wallet).
  const chosenKey = chosen.map((i) => i.ticker).join(",");
  useEffect(() => {
    if (!session?.token || chosen.length === 0) return setQ(null);
    let stop = false;
    const t = setTimeout(async () => {
      const icons = listOn === "justhoot" ? await webpIcons(chosen) : undefined;
      if (stop) return;
      quote(chosen, listOn, session.token, rheaOpts, icons)
        .then((r) => !stop && (setQ(r), setQErr(null)))
        .catch((e) => !stop && (setQ(null), setQErr((e as Error).message)));
    }, 300);
    return () => {
      stop = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, chosenKey, listOn, fdv, creatorPct]);

  // Redirect wallets come back with ?transactionHashes=; finish those Nearly launches.
  useEffect(() => {
    if (!session?.token) return;
    const { venue, items: done } = takeRedirectedNearly();
    if (!done.length) return;
    (venue === "justhoot" ? justhootFinalize : nearlyFinalize)(done, session.token)
      .then((r) => setResult({ txHash: done[0].txHash, explorerUrl: `${EXPLORER_BASE}/txns/${done[0].txHash}`, results: r.results }))
      .then(() => loadLaunches())
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  // Re-list an existing token on Rhea: wallet sends it to the vault, then the API lists it.
  const relist = (tokenId: string) =>
    run("relist", async () => {
      const token = await authToken(account!);
      if (!token) return;
      const bal = await viewCall<string>(tokenId, "ft_balance_of", { account_id: account });
      if (!bal || BigInt(bal) === 0n) throw new Error("you hold none of this token");
      setProgress("Confirm in your wallet: send the tokens to the vault for listing…");
      try {
        if (!(await sendForRelist(tokenId, bal))) return;
        setProgress("Listing on Rhea…");
        const r = await listOnRhea(tokenId, token, rheaOpts);
        if (!r.listing.ok) throw new Error(r.listing.error ?? "listing failed; tokens were returned to your wallet");
      } finally {
        setProgress(null);
      }
      await refresh();
      await loadLaunches();
    });

  useEffect(() => {
    if (!session?.token) return;
    const t = takeRedirectedRelist();
    if (!t) return;
    listOnRhea(t, session.token, rheaOpts)
      .then(() => loadLaunches())
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  const launchNearly = async (token: string) => {
    const prep = await nearlyPrepare(chosen, token);
    setProgress(`Sign ${prep.txs.length} Nearly launch${prep.txs.length > 1 ? "es" : ""} in your wallet…`);
    const signed = await signCallsInChunks(prep.txs, prep.chunk, (n) => setProgress(`Signed ${n}/${prep.txs.length}…`));
    if (!signed.length) throw new Error("the wallet returned no transactions");
    setProgress("Recording your tokens…");
    const r = await nearlyFinalize(signed, token);
    setResult({ txHash: signed[0].txHash, explorerUrl: `${EXPLORER_BASE}/txns/${signed[0].txHash}`, results: r.results });
  };

  // JustHoot: same wallet-signed flow; the browser makes a <=7000-char webp icon (API falls back to SVG / none).
  const launchJusthoot = async (token: string) => {
    const prep = await justhootPrepare(chosen, await webpIcons(chosen), token);
    setProgress(`Sign ${prep.txs.length} JustHoot launch${prep.txs.length > 1 ? "es" : ""} in your wallet…`);
    const signed = await signCallsInChunks(prep.txs, prep.chunk, (n) => setProgress(`Signed ${n}/${prep.txs.length}…`), "justhoot");
    if (!signed.length) throw new Error("the wallet returned no transactions");
    setProgress("Recording your tokens…");
    const r = await justhootFinalize(signed, token);
    setResult({ txHash: signed[0].txHash, explorerUrl: `https://nearblocks.io/txns/${signed[0].txHash}`, results: r.results });
  };

  const run = async (kind: Busy, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof UnauthorizedError) setSession(null);
      if (e instanceof NotWhitelistedError) {
        setSession(null);
        setNotWhitelisted(true);
        return;
      }
      setError(friendlyWalletError(e).message);
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => (await initWallet()).modal.show();

  const adminToken = useCallback(async () => {
    if (!account) return null;
    const s = getSession(account) ?? (await ensureSession(account));
    setSession(s);
    return s?.token ?? null;
  }, [account]);
  const onAdminError = useCallback((e: Error) => {
    if (e instanceof UnauthorizedError) setSession(null);
    if (e instanceof NotWhitelistedError) setNotWhitelisted(true);
  }, []);

  const isLocked = locked !== false;

  // Signed in (or tried to) with an account that isn't on the allowlist.
  if (account && notWhitelisted) {
    return (
      <section className="card center locked-card">
        <span className="locked-emoji" aria-hidden="true">🚧</span>
        <h2>You're not on the whitelist yet</h2>
        <p className="muted">
          <strong>{account}</strong> can't yeet just yet: Yeetpad is invite-only for now. Hop on the list and we'll wave you in soon.
        </p>
        <WaitlistForm key={account} initialAccount={account} />
        <p className="small locked-alt">
          <button className="link" onClick={() => signOut().then(() => setSession(null))}>Sign out / switch wallet</button>
        </p>
      </section>
    );
  }

  // Locked: lead with the whitelist form; whitelisted folks can still connect.
  if (!account && isLocked && !showConnect) {
    return (
      <section className="card center locked-card">
        <span className="locked-emoji" aria-hidden="true">🔒</span>
        <h2>The factory is invite-only (for now)</h2>
        <p className="muted">We're letting yeeters in a few at a time. Join the whitelist and we'll open the door for your wallet.</p>
        <WaitlistForm />
        {error && <p className="error">{error}</p>}
        <p className="small muted locked-alt">
          Already whitelisted?{" "}
          <button className="link" onClick={() => setShowConnect(true)}>
            Connect your wallet
          </button>
        </p>
      </section>
    );
  }

  // Locked + connected but not verified yet: verify first, so nobody tops up credits they can't use.
  if (account && isLocked && !session) {
    return (
      <section className="card center locked-card">
        <span className="locked-emoji" aria-hidden="true">🎟️</span>
        <h2>Show your ticket</h2>
        <p className="muted">
          Yeetpad is whitelist-only right now. Sign a short message with <strong>{account}</strong> (free, no transaction) so we can check
          you're on the list.
        </p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button disabled={busy !== null} onClick={() => run("verify", async () => void (await authToken(account)))}>
            {busy === "verify" ? "Sign in wallet…" : "Verify wallet"}
          </button>
          <button className="ghost" onClick={() => signOut().then(() => setSession(null))}>Sign out</button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  if (!account) {
    return (
      <section className="card center">
        <h2>1. Connect your NEAR wallet</h2>
        <p className="muted">NEAR {NETWORK}. MyNearWallet, Meteor or HERE.</p>
        <button onClick={connect}>Connect wallet</button>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  const tabs = isAdmin && (
    <nav className="studio-tabs" role="tablist" aria-label="Studio sections">
      <button role="tab" aria-selected={tab === "studio"} onClick={() => openTab("studio")}>🏭 Studio</button>
      <button role="tab" aria-selected={tab === "admin"} onClick={() => openTab("admin")}>🛡️ Admin</button>
    </nav>
  );

  if (isAdmin && tab === "admin") {
    return (
      <>
        {tabs}
        <Admin getToken={adminToken} onAuthError={onAdminError} />
      </>
    );
  }

  return (
    <>
    {tabs}
    <div className="dash">
      <aside className="dash-side">
      <section className="card s-wallet">
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

      <section className="card s-topup">
        <h2>2. Top up credits</h2>
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

      <section className="card s-mine">
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
              <li key={l.tokenId}>
                <span className="dot" style={{ background: l.colors?.primary ?? "var(--pink)" }} />
                <div className="ml-body">
                  <a className="ml-name" href={`/t/${l.slug ?? l.ticker}`}>
                    {l.name ?? l.ticker.toUpperCase()}
                  </a>
                  <span className="ml-meta small">
                    <span className="ml-tk">${l.ticker.toUpperCase()}</span>
                    <span className="muted when">{fmtWhen(l.createdAt)}</span>
                    <span className="ml-views" title="Page views (approximate, no cookies)">👀 {l.views ?? 0}</span>
                    <a href={l.explorerUrl} target="_blank" rel="noreferrer">explorer ↗</a>
                    {l.venue && l.venue !== "yeetpad" && l.venueUrl && (
                      <a href={l.venueUrl} target="_blank" rel="noreferrer">
                        {l.venue === "rhea" ? "Rhea ↗" : l.venue === "justhoot" ? "JustHoot ↗" : "Nearly ↗"}
                      </a>
                    )}
                    {l.ownerId === account && (l.venue ?? "yeetpad") === "yeetpad" && (
                      <button className="link" disabled={busy !== null} title="Send your tokens to the vault and list them on Rhea (you get the LP position)" onClick={() => relist(l.tokenId)}>
                        {busy === "relist" ? "listing…" : "list on Rhea"}
                      </button>
                    )}
                    {l.ownerId === account && (
                      <button className="link" onClick={() => setOpenSettings(openSettings === l.ticker ? null : l.ticker)}>
                        settings
                      </button>
                    )}
                  </span>
                  {openSettings === l.ticker && (
                    <SiteSettings
                      current={l.gaId ?? null}
                      busy={busy !== null}
                      onSave={(gaId) =>
                        run("settings", async () => {
                          const token = await authToken(account);
                          if (!token) return;
                          await saveSiteSettings(l.slug ?? l.ticker, gaId, token);
                          setOpenSettings(null);
                          await loadLaunches();
                        })
                      }
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {busy === "relist" && progress && <p className="muted small">{progress}</p>}
      </section>
      </aside>

      <div className="dash-main">
      <section className="card s-gen">
        <h2>3. Generate ideas</h2>
        {!session && (
          <p className="muted small">
            First time this session? Your wallet will ask you to sign a short message (free, no transaction) so the API knows it's really you.
          </p>
        )}
        <textarea
          rows={4}
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

        {ideas.length > 0 && (
        <div className="idea-grid">
        {ideas.map((idea, i) => (
          <IdeaCard
            key={i}
            idea={idea}
            picked={ideas.length > 1 ? picked[i] : undefined}
            onPick={(v) => setPicked(picked.map((p, j) => (j === i ? v : p)))}
            onTicker={(ticker) => setIdeas(ideas.map((x, j) => (j === i ? { ...x, ticker } : x)))}
          />
        ))}
        </div>
        )}
        {ideas.length === 0 && (
          <div className="idea-empty">
            <span aria-hidden="true">💡</span>
            <p>
              <strong>Your ideas land here.</strong> Describe a vibe, pick how many (up to {MAX_BATCH}), and hit Generate. Each idea costs a tiny
              bit of vault credit; you can tweak tickers before launching.
            </p>
          </div>
        )}
      </section>

      {ideas.length > 0 && (
        <section className="card s-launch">
          <h2>4. Yeet it</h2>
          <div className="venue-pick" role="radiogroup" aria-label="List on">
            <span className="muted small">List on</span>
            {(
              [
                ["none", "None", "Token only"],
                ["rhea", "Rhea (direct)", "Our token + Rhea DCL pool"],
                ["nearly", "Nearly", "Nearly's token + pool"],
                ["justhoot", "JustHoot", "JustHoot's token + Rhea pool"],
              ] as const
            ).map(([v, label, hint]) => {
              const off = v === "nearly" ? nearlyOff : v === "justhoot" ? justhootOff : null;
              return (
              <button
                key={v}
                role="radio"
                aria-checked={listOn === v}
                className={listOn === v ? "on" : ""}
                disabled={off !== null}
                onClick={() => setListOn(v)}
                title={off ?? hint}
              >
                {label}
              </button>
              );
            })}
          </div>
          {(nearlyOff || justhootOff) && (
            <p className="muted small">
              {[nearlyOff && `Nearly: ${nearlyOff}`, justhootOff && `JustHoot: ${justhootOff}`].filter(Boolean).join(" · ")}
            </p>
          )}
          <p className="muted small">
            {listOn === "none" && (
              <>Creates {chosen.length === 1 ? "a NEP-141 token" : `${chosen.length} NEP-141 tokens in one transaction`} owned by you, paid from your vault credit (a failed item is refunded).</>
            )}
            {listOn === "rhea" && (
              <>
                Creates your token{chosen.length > 1 ? "s" : ""}, then the vault opens a Rhea DCL pool <code>token|wNEAR</code> (1% fee tier) and adds the supply
                one-sided. You get the LP position (NFT) and any tokens not in the pool, straight to your wallet. Paid from vault credit, one click.
              </>
            )}
            {listOn === "nearly" && (
              <>
                Nearly's factory creates and lists the token; your wallet signs and pays each launch ({chosen.length > 1 ? "batched in one wallet prompt" : "one prompt"}).
                Nearly locks the LP in its own locker and takes its trading fees.
              </>
            )}
            {listOn === "justhoot" && (
              <>
                JustHoot creates the token and its Rhea pool; your wallet signs and pays the exact launch deposit ({chosen.length > 1 ? `batched, up to 10 per wallet prompt` : "one prompt"}).
                JustHoot's pool creator holds the LP; you're the token's fee recipient. Tickers up to 10 characters. Description and socials appear on your
                Yeetpad site page (linked on-chain as the token's reference), not in JustHoot's socials form.
              </>
            )}{" "}
            Each gets a site at <code>/t/&lt;token-name&gt;</code>.
          </p>
          {listOn === "rhea" && (
            <div className="venue-opts row">
              <label>
                Opening valuation (FDV, NEAR) <input type="number" min="1" value={fdv} onChange={(e) => setFdv(e.target.value)} />
              </label>
              <label>
                Keep for you (% of supply) <input type="number" min="0" max="90" value={creatorPct} onChange={(e) => setCreatorPct(e.target.value)} />
              </label>
              {q?.rhea && <span className="muted small">opening point {q.rhea.initPoint} · price ≈ {(rheaOpts.openingFdvNear / 1e9).toPrecision(3)} NEAR/token</span>}
            </div>
          )}
          {q && q.listOn === listOn && (
            <table className="cost-table small">
              <tbody>
                {q.items.map((it) => (
                  <tr key={it.ticker}>
                    <td>${it.ticker.toUpperCase()}</td>
                    <td className="muted">{Object.entries(it.parts).map(([k, v]) => `${k.replace(/_/g, " ")} ${formatNear(BigInt(v))}`).join(" · ")}</td>
                    <td className="num">~{formatNear(BigInt(it.total))} NEAR</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td className="muted">{q.items[0]?.paidFrom === "wallet" ? "from your wallet" : "from vault credit"}</td>
                  <td className="num">~{formatNear(BigInt(q.total))} NEAR</td>
                </tr>
              </tbody>
            </table>
          )}
          {q?.notes?.map((n) => (
            <p key={n} className="muted small">{n}</p>
          ))}
          {!q && session && qErr && <p className="muted small">Cost estimate unavailable: {qErr}</p>}
          <button
            disabled={busy !== null || chosen.length === 0}
            onClick={() =>
              run("launch", async () => {
                const token = await authToken(account);
                if (!token) return;
                setProgress(listOn === "rhea" ? "Launching and listing on Rhea (about 10 s per token)…" : null);
                try {
                  if (listOn === "nearly") await launchNearly(token);
                  else if (listOn === "justhoot") await launchJusthoot(token);
                  else setResult(await launchBatch(account, chosen, token, listOn, rheaOpts));
                } finally {
                  setProgress(null);
                }
                await refresh();
                await loadLaunches();
              })
            }
          >
            {busy === "launch"
              ? "Launching…"
              : `${chosen.length > 1 ? `Launch ${chosen.length} tokens` : "Launch token"}${listOn === "rhea" ? " + list on Rhea" : listOn === "nearly" ? " on Nearly" : listOn === "justhoot" ? " on JustHoot" : ""}`}
          </button>
          {progress && <p className="muted small">{progress}</p>}
          {result && (
            <div className="result">
              <ul className="launch-results">
                {result.results.map((r) => (
                  <li key={r.ticker}>
                    {r.ok ? "✅" : "❌"} <strong>${r.ticker.toUpperCase()}</strong>{" "}
                    {r.ok ? (
                      <>
                        <code>{r.tokenId}</code> · <a href={`/t/${r.slug ?? r.ticker}`}>open site →</a>
                        {r.listing && (
                          <>
                            {" "}
                            ·{" "}
                            {r.listing.ok && r.listing.url ? (
                              <a href={r.listing.url} target="_blank" rel="noreferrer">
                                {r.listing.venue === "rhea" ? "Rhea pool ↗" : r.listing.venue === "justhoot" ? "JustHoot ↗" : "Nearly ↗"}
                              </a>
                            ) : (
                              <span className="muted">{r.listing.error}</span>
                            )}
                          </>
                        )}
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


      {error && <p className="error">{error}</p>}
      </div>
    </div>
    </>
  );
}

const GA_RE = /^G-[A-Z0-9]{4,12}$/;

/** Creator settings for a token page: optional own Google Analytics 4 id. */
function SiteSettings({ current, busy, onSave }: { current: string | null; busy: boolean; onSave: (gaId: string | null) => void }) {
  const [v, setV] = useState(current ?? "");
  const id = v.trim().toUpperCase();
  const ok = id === "" || GA_RE.test(id);
  return (
    <div className="ml-settings">
      <label className="small">
        Your Google Analytics ID <span className="muted">(GA4, optional)</span>
        <input value={v} placeholder="G-XXXXXXXXXX" spellCheck={false} onChange={(e) => setV(e.target.value)} aria-invalid={!ok} />
      </label>
      {!ok && <span className="small err-inline">Looks like G- followed by 4–12 letters/digits.</span>}
      <div className="row">
        <button className="ghost" disabled={busy || !ok || id === (current ?? "")} onClick={() => onSave(id || null)}>
          Save
        </button>
        {current && (
          <button className="ghost" disabled={busy} onClick={() => onSave(null)}>
            Clear
          </button>
        )}
      </div>
      <p className="muted small">Adds your GA tag to this token's page only. Visitors see a short note that the page may use your analytics.</p>
    </div>
  );
}

function fmtWhen(ms: number) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit" });
}

/** True if `fg` has at least `min` WCAG contrast on `bg` (3 = large headings, 4.5 = body text). */
function readable(fg: string, bg: string, min = 3) {
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
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= min;
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
  const pillText = readable(c.background, c.accent, 4.5) ? c.background : readable("#1b1433", c.accent, 4.5) ? "#1b1433" : "#ffffff";
  return (
    <div className="idea" style={{ background: c.background, color: c.text, borderColor: c.primary, opacity: picked === false ? 0.55 : 1 }}>
      <div className="idea-top">
        {picked !== undefined ? (
          <label className="pick small">
            <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} /> launch
          </label>
        ) : (
          <span />
        )}
        <label className="ticker" style={{ background: c.accent, color: pillText }}>
          $
          <input
            value={idea.ticker}
            style={{ width: `${Math.max(3, idea.ticker.length) + 1}ch` }}
            maxLength={16}
            onChange={(e) => onTicker(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16))}
            aria-label="ticker"
          />
        </label>
      </div>
      <h3 style={{ color: readable(c.primary, c.background) ? c.primary : c.text }}>{idea.name}</h3>
      <p className="idea-tagline" style={{ color: readable(c.secondary, c.background, 4.5) ? c.secondary : c.text }}>
        <em>{idea.tagline}</em>
      </p>
      <p>{idea.description}</p>
      <div className="swatches">
        {Object.entries(c).map(([k, v]) => (
          <span key={k} title={`${k} ${v}`} style={{ background: v }} />
        ))}
      </div>
    </div>
  );
}

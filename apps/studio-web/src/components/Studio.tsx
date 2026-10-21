import { useCallback, useEffect, useState } from "react";
import { formatNear, parseNear, type LaunchIdea, type LaunchResponse } from "@osl/schema";
import "@near-wallet-selector/modal-ui/styles.css";
import { initWallet, depositCredits, signOut } from "../lib/wallet";
import { getVaultBalance } from "../lib/near";
import { generate, launch } from "../lib/api";
import { VAULT_CONTRACT } from "../lib/config";

type Busy = null | "deposit" | "generate" | "launch";

export default function Studio() {
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [prompt, setPrompt] = useState("");
  const [idea, setIdea] = useState<LaunchIdea | null>(null);
  const [result, setResult] = useState<LaunchResponse | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

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
            <strong>{account}</strong>
          </div>
          <button className="ghost" onClick={() => signOut()}>Sign out</button>
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
              const r = await generate(prompt.trim(), account);
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
                setResult(await launch(account, idea));
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

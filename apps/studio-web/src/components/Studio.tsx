import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatNear,
  parseNear,
  MAX_BATCH,
  MAX_RUN,
  chunk,
  chunkSizes,
  clampRun,
  dedupeIdeas,
  hasErrors,
  pool,
  runErrors,
  shufflePalette,
  type IdeaErrors,
  tokenIconDataUri,
  type BatchLaunchResponse,
  type LaunchedToken,
  type LaunchIdea,
  type QuoteResponse,
  type SessionResponse,
} from "@osl/schema";
import "@near-wallet-selector/modal-ui/styles.css";
import { initWallet, depositCredits, friendlyWalletError, sendForRelist, signCallsInChunks, signOut, takeRedirectedNearly, takeRedirectedRelist } from "../lib/wallet";
import { viewCall } from "../lib/near";
import { getVaultBalance } from "../lib/near";
import { removablePositions, removeLiquidityCall, type DclPosition } from "../lib/dcl";
import { aiComputeCost, ApiError, tokensAction, appLocked, generate, justhootFinalize, justhootPrepare, launchBatch, listOnRhea, me, myLaunches, nearlyFinalize, nearlyPrepare, quote, saveSiteSettings, UnauthorizedError, venueStatus, type ListOnChoice } from "../lib/api";
import { applyResults, isDone, loadDraft, loadRun, mark, newRun, reconcile, runCounts, saveDraft, saveRun, type LaunchRun, type RunItem } from "../lib/run";
import MyTokens from "./MyTokens";
import { webpIcons } from "../lib/icon";
import { DCL_CONTRACT, EXPLORER_BASE, NETWORK } from "../lib/config";
import { NotWhitelistedError, clearSession, completeRedirectSignIn, ensureSession, getSession } from "../lib/auth";
import { WaitlistForm } from "./WaitlistForm";
import Admin from "./Admin";
import { VAULT_CONTRACT } from "../lib/config";

type Busy = null | "deposit" | "generate" | "launch" | "verify" | "settings" | "relist" | "delete";
type Tab = "studio" | "tokens" | "admin";
const COUNT_PRESETS = [1, 5, 10, 25, 50, 100];
/** Ideas list switches from full cards to light rows above this many. */
const CARD_MAX = 6;
/** Generation chunks in flight at once (each is one /api/generate call of up to MAX_BATCH ideas). */
const GEN_CONCURRENCY = 3;
const tabFromHash = (): Tab => (typeof location === "undefined" ? "studio" : location.hash === "#admin" ? "admin" : location.hash === "#tokens" ? "tokens" : "studio");

export default function Studio() {
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(1);
  const [customCount, setCustomCount] = useState("");
  const [genProgress, setGenProgress] = useState<string | null>(null);
  const genStop = useRef(false);
  const [lrun, setLrun] = useState<LaunchRun | null>(null);
  const runRef = useRef<LaunchRun | null>(null);
  const launchStop = useRef(false);
  const [aiCost, setAiCost] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<LaunchIdea[]>([]);
  const [picked, setPicked] = useState<boolean[]>([]);
  /** As generated (for "Reset to original"); parallel to `ideas`. */
  const [originals, setOriginals] = useState<LaunchIdea[]>([]);
  const [editing, setEditing] = useState<Set<number>>(new Set());
  const [regen, setRegen] = useState<Set<number>>(new Set());
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
  const [notice, setNotice] = useState<string | null>(null);
  const [nearlyOff, setNearlyOff] = useState<string | null>(null);
  const [justhootOff, setJusthootOff] = useState<string | null>("mainnet only, enabled at mainnet launch");
  useEffect(() => {
    venueStatus(account).then((v) => {
      setNearlyOff(v.nearly.enabled ? null : v.nearly.reason);
      setJusthootOff(v.justhoot.enabled ? null : v.justhoot.reason);
    });
  }, [account]);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const openTab = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", t === "studio" ? location.pathname + location.search : `#${t}`);
  };
  useEffect(() => {
    const on = () => setTab(tabFromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    aiComputeCost().then(setAiCost).catch(() => {});
  }, []);

  // ---- launch run (persisted in localStorage; survives redirect wallets and reloads) ----
  const setRun = (r: LaunchRun | null) => {
    runRef.current = r;
    saveRun(r);
    setLrun(r);
  };
  const updRun = (f: (r: LaunchRun) => LaunchRun) => {
    if (runRef.current) setRun(f(runRef.current));
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
      // Includes taken-down tokens (deletedAt) for My tokens → "Show deleted"; everything else hides them.
      setLaunches((await myLaunches(account, true)).launches);
    } catch {
      setLaunches([]);
    }
  }, [account]);
  useEffect(() => void loadLaunches(), [loadLaunches]);

  // Generated + edited ideas survive a reload / wallet redirect (per account) until the next generation.
  useEffect(() => {
    if (!account) return;
    const d = loadDraft(account);
    if (d && ideasRef.current.length === 0) {
      setIdeas(d.ideas);
      setPicked(d.picked);
      setOriginals(d.originals);
      if (d.prompt) setPrompt(d.prompt);
    }
  }, [account]);
  useEffect(() => {
    if (!account) return;
    const t = setTimeout(() => saveDraft(account, { prompt, ideas, picked, originals }), 300);
    return () => clearTimeout(t);
  }, [account, prompt, ideas, picked, originals]);

  // A run left over from a reload / redirect: show it, and mark items that did launch (from My launches) as done.
  useEffect(() => {
    if (!account) return;
    const r = loadRun(account);
    runRef.current = r;
    setLrun(r);
    if (!r || !r.items.some((i) => !isDone(i.status) && i.status !== "failed")) return;
    myLaunches(account)
      .then(({ launches }) => runRef.current && setRun(reconcile(runRef.current, launches)))
      .catch(() => {});
  }, [account]);

  const ideasRef = useRef<LaunchIdea[]>([]);
  ideasRef.current = ideas;
  const chosen = ideas.filter((_, i) => picked[i]);
  const rheaOpts = { openingFdvNear: Number(fdv) || 1000, creatorPct: Math.min(90, Math.max(0, Number(creatorPct) || 0)) };

  // Cost estimate from the venue's quote views (only with a live session; never prompts the wallet).
  const chosenKey = chosen.map((i) => i.ticker).join(",");
  useEffect(() => {
    if (!session?.token || chosen.length === 0 || runErrors(chosen, undefined, { venue: listOn }).some(hasErrors)) return setQ(null);
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
      .then((r) => {
        if (runRef.current) updRun((x) => applyResults(x, r.results));
        else setResult({ txHash: done[0].txHash, explorerUrl: `${EXPLORER_BASE}/txns/${done[0].txHash}`, results: r.results });
      })
      .then(() => loadLaunches())
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  // Re-list existing tokens on Rhea: per token, the wallet sends it to the vault, then the API lists it.
  // Bulk = one wallet approval per token, in order; a redirect wallet leaves after the first.
  const relist = (tokenIds: string[]) =>
    run("relist", async () => {
      const token = await authToken(account!);
      if (!token) return;
      let ok = 0;
      try {
        for (const [k, tokenId] of tokenIds.entries()) {
          const of = tokenIds.length > 1 ? ` (${k + 1} of ${tokenIds.length})` : "";
          try {
            const bal = await viewCall<string>(tokenId, "ft_balance_of", { account_id: account });
            if (!bal || BigInt(bal) === 0n) throw new Error("you hold none of this token");
            setProgress(`Confirm in your wallet${of}: send ${tokenId.split(".")[0].toUpperCase()} to the vault for listing…`);
            if (!(await sendForRelist(tokenId, bal))) return;
            setProgress(`Listing on Rhea${of}…`);
            const r = await listOnRhea(tokenId, token, rheaOpts);
            if (!r.listing.ok) throw new Error(r.listing.error ?? "listing failed; tokens were returned to your wallet");
            ok++;
          } catch (e) {
            const msg = friendlyWalletError(e).message;
            throw new Error(tokenIds.length > 1 ? `Listed ${ok} of ${tokenIds.length}; stopped at ${tokenId.split(".")[0].toUpperCase()}: ${msg}` : msg);
          }
        }
      } finally {
        setProgress(null);
        await refresh();
        await loadLaunches();
      }
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

  /** Creator's DCL positions for these tokens (one list_liquidities view). */
  const loadPositions = async (tokenIds: string[]) => {
    const all = ((await viewCall<DclPosition[]>(DCL_CONTRACT, "list_liquidities", { account_id: account })) ?? []) as DclPosition[];
    return new Map(tokenIds.map((t) => [t, removablePositions(all, t, account!)] as const));
  };

  /** Delete = take the sites down (API) first, then optionally pull Rhea liquidity (wallet-signed, 10 per approval). */
  const deleteTokens = (tickers: string[], positions: { ticker: string; p: DclPosition }[]) =>
    run("delete", async () => {
      setNotice(null);
      const token = await authToken(account!);
      if (!token) return;
      setProgress(`Taking down ${tickers.length} page${tickers.length > 1 ? "s" : ""}…`);
      try {
        const res = await tokensAction("delete", tickers, token);
        const ok = res.filter((r) => r.ok).length;
        const bad = res.filter((r) => !r.ok);
        let msg = `Took down ${ok} page${ok === 1 ? "" : "s"}.`;
        await loadLaunches();
        if (positions.length) {
          const calls = positions.map(({ ticker, p }) => removeLiquidityCall(DCL_CONTRACT, p, ticker));
          try {
            const signed = await signCallsInChunks(calls, 10, {
              persist: false,
              onPrompt: (k, of) => setProgress(`Pulling liquidity: approval ${k} of ${of} in your wallet (${Math.min(10, calls.length - (k - 1) * 10)} position${calls.length > 1 ? "s" : ""})…`),
            });
            msg += ` Pulled ${signed.length}/${calls.length} Rhea position${calls.length > 1 ? "s" : ""} back to your wallet.`;
          } catch (e) {
            msg += ` Liquidity not withdrawn: ${friendlyWalletError(e).message}. You can pull it from Rhea directly.`;
          }
        }
        setNotice(msg);
        if (bad.length) setError(`Not taken down: ${bad.map((b) => `${b.ticker.toUpperCase()} (${b.note})`).join(", ")}`);
      } finally {
        setProgress(null);
        await refresh();
        await loadLaunches();
      }
    });
  const restoreTokens = (tickers: string[]) =>
    run("delete", async () => {
      setNotice(null);
      const token = await authToken(account!);
      if (!token) return;
      const res = await tokensAction("restore", tickers, token);
      const bad = res.filter((r) => !r.ok);
      setNotice(`Restored ${res.length - bad.length} page${res.length - bad.length === 1 ? "" : "s"}.`);
      if (bad.length) setError(`Not restored: ${bad.map((b) => `${b.ticker.toUpperCase()} (${b.note})`).join(", ")}`);
      await loadLaunches();
    });

  const isAuthErr = (e: unknown) => e instanceof UnauthorizedError || e instanceof NotWhitelistedError;
  const runProgress = () => {
    const r = runRef.current;
    if (!r) return;
    const c = runCounts(r);
    return `Launched ${c.done}/${c.total}${c.failed ? ` · ${c.failed} failed` : ""}`;
  };

  /** None / Rhea: vault calls of MAX_BATCH tokens, one after another (one relayer key: no nonce clashes). */
  const launchVault = async (token: string) => {
    for (;;) {
      const r = runRef.current!;
      if (launchStop.current) break;
      const next = r.items.filter((i) => i.status === "pending").slice(0, MAX_BATCH);
      if (!next.length) break;
      const tickers = next.map((i) => i.idea.ticker);
      updRun((x) => mark(x, tickers, "sending"));
      setProgress(`${runProgress()} · sending ${tickers.length}${r.venue === "rhea" ? " (Rhea listing ~10 s per token)" : ""}…`);
      try {
        const res = await launchBatch(account!, next.map((i) => i.idea), token, r.venue as "none" | "rhea", r.rhea);
        updRun((x) => applyResults(x, res.results, res.txHash));
      } catch (e) {
        if (isAuthErr(e)) {
          updRun((x) => mark(x, tickers, "pending"));
          throw e;
        }
        const ae = e as ApiError;
        const body = ae instanceof ApiError ? ae.body : undefined;
        if (ae instanceof ApiError && ae.status === 402) {
          updRun((x) => mark(x, tickers, "pending"));
          throw new Error(`${ae.message}. Top up credits, then press Resume (${runCounts(runRef.current!).done} already launched).`);
        }
        if (Array.isArray(body?.results) && body.results.length) {
          updRun((x) => applyResults(x, body.results as BatchLaunchResponse["results"], (body.txHash as string) ?? null));
          continue;
        }
        // Taken tickers / lost response: anything of this chunk that is already in My launches counts as done.
        const ls = await myLaunches(account!).then((j) => j.launches).catch(() => [] as LaunchedToken[]);
        const taken = new Set(ae instanceof ApiError && ae.status === 409 ? (body?.taken ?? []) : []);
        updRun((x) => {
          const y = reconcile(mark(x, tickers, "pending"), ls);
          const left = y.items.filter((i) => tickers.includes(i.idea.ticker) && i.status === "pending");
          if (taken.size) return mark(y, left.filter((i) => taken.has(i.idea.ticker)).map((i) => i.idea.ticker), "failed", "ticker is taken; edit it and retry");
          return mark(y, left.map((i) => i.idea.ticker), "failed", `${(e as Error).message || "request failed"} (credits refunded on-chain if the launch failed)`);
        });
      }
    }
  };

  /** Nearly / JustHoot: prepare in MAX_BATCH chunks, then the wallet signs `chunk` (10) per prompt. */
  const launchWallet = async (token: string, venue: "nearly" | "justhoot") => {
    const unprepared = runRef.current!.items.filter((i) => i.status === "pending" && !i.tx);
    let size = runRef.current!.walletChunk ?? 10;
    for (const [k, part] of chunk(unprepared, MAX_BATCH).entries()) {
      if (launchStop.current) return;
      setProgress(`Preparing ${Math.min((k + 1) * MAX_BATCH, unprepared.length)}/${unprepared.length}…`);
      const ideas = part.map((i) => i.idea);
      const prep = venue === "justhoot" ? await justhootPrepare(ideas, await webpIcons(ideas), token) : await nearlyPrepare(ideas, token);
      size = prep.chunk || size;
      const by = new Map(prep.txs.map((t) => [t.ticker, t]));
      updRun((x) => ({ ...x, walletChunk: size, items: x.items.map((it) => (by.has(it.idea.ticker) ? { ...it, tx: by.get(it.idea.ticker) } : it)) }));
    }
    const todo = runRef.current!.items.filter((i) => i.status === "pending" && i.tx);
    if (!todo.length) return;
    const fin = venue === "justhoot" ? justhootFinalize : nearlyFinalize;
    let current: string[] = [];
    try {
      await signCallsInChunks(
        todo.map((i) => ({ ...i.tx!, ticker: i.idea.ticker })),
        size,
        {
          onPrompt: (k, of) => {
            current = todo.slice((k - 1) * size, k * size).map((i) => i.idea.ticker);
            updRun((x) => mark(x, current, "signing"));
            setProgress(`${runProgress()} · approval ${k} of ${of} in your wallet (${current.length} launch${current.length > 1 ? "es" : ""})…`);
          },
          onSigned: async (signed) => {
            setProgress(`${runProgress()} · recording ${signed.length}…`);
            const r = signed.length ? await fin(signed, token) : { results: [] };
            updRun((x) => {
              const y = applyResults(x, r.results);
              const got = new Set(signed.map((s) => s.ticker));
              return mark(y, current.filter((t) => !got.has(t)), "failed", "the wallet returned no transaction for this one");
            });
            current = [];
          },
        },
        venue,
      );
    } catch (e) {
      if (current.length) updRun((x) => mark(x, current, "pending"));
      throw e;
    }
  };

  const continueRun = async (token: string) => {
    launchStop.current = false;
    const r = runRef.current;
    if (!r) return;
    try {
      if (r.venue === "nearly" || r.venue === "justhoot") await launchWallet(token, r.venue);
      else await launchVault(token);
    } finally {
      setProgress(null);
      // Launched ideas drop out of the selection so a second click doesn't relaunch them.
      const done = new Set((runRef.current?.items ?? []).filter((i) => isDone(i.status)).map((i) => i.idea.ticker));
      setPicked((p) => p.map((v, j) => v && !done.has(ideasRef.current[j]?.ticker)));
      await refresh();
      await loadLaunches();
    }
  };

  const startLaunch = () =>
    run("launch", async () => {
      const left = runRef.current ? runCounts(runRef.current).left : 0;
      if (left > 0 && !confirm(`Your previous run still has ${left} token(s) not launched. Start a new run instead?`)) return;
      const token = await authToken(account!);
      if (!token) return;
      if ((listOn === "none" || listOn === "rhea") && q && q.listOn === listOn && q.items.length === chosen.length) {
        const bal = BigInt(await getVaultBalance(account!));
        const need = BigInt(q.total);
        if (bal < need) throw new Error(`This run needs ~${formatNear(need)} NEAR of credits; you have ${formatNear(bal)}. Top up at least ${formatNear(need - bal)} NEAR first.`);
      }
      setResult(null);
      setRun(newRun(account!, listOn, chosen, rheaOpts));
      await continueRun(token);
    });
  const resumeRun = () =>
    run("launch", async () => {
      const token = await authToken(account!);
      if (token) await continueRun(token);
    });
  const retryFailed = () =>
    run("launch", async () => {
      updRun((x) => ({ ...x, items: x.items.map((it) => (it.status === "failed" ? { ...it, status: "pending", error: null, tx: undefined } : it)) }));
      const token = await authToken(account!);
      if (token) await continueRun(token);
    });

  /** Generates `count` ideas as MAX_BATCH-sized /api/generate calls, GEN_CONCURRENCY at a time. */
  const generateRun = () =>
    run("generate", async () => {
      const token = await authToken(account!);
      if (!token) return;
      const n = clampRun(count);
      const per = BigInt(aiCost ?? (await aiComputeCost()));
      const need = per * BigInt(n);
      const bal = BigInt(await getVaultBalance(account!));
      if (bal < need) {
        throw new Error(`${n} idea${n > 1 ? "s" : ""} cost ${formatNear(need)} NEAR in credits; you have ${formatNear(bal)}. Top up at least ${formatNear(need - bal)} NEAR first.`);
      }
      genStop.current = false;
      setIdeas([]);
      setPicked([]);
      setOriginals([]);
      setEditing(new Set());
      ideasRef.current = [];
      setResult(null);
      const seen = { names: new Set<string>(), tickers: new Set<string>() };
      const used: string[] = [];
      let got = 0;
      let lastErr: string | null = null;
      let authErr: unknown = null;
      setGenProgress(`Generated 0/${n}…`);
      // A second, smaller round tops up ideas dropped as duplicates (charged like any chunk).
      for (let round = 0; round < 2 && got < n && !genStop.current && !authErr; round++) {
        const before = got;
        let seq = round * MAX_RUN; // each chunk/idea gets its own angle; a top-up round shifts to fresh ones
        await pool(
          chunkSizes(n - got).map((size) => {
            const at = seq;
            seq += size;
            return async () => {
            if (genStop.current || authErr) throw Object.assign(new Error("stopped"), { noRetry: true });
            try {
              const r = await generate(prompt.trim(), account!, token, size, used.slice(-24), at);
              return r.ideas ?? [r.idea];
            } catch (e) {
              if (isAuthErr(e)) {
                authErr = e;
                Object.assign(e as object, { noRetry: true });
              }
              throw e;
            }
            };
          }),
          {
            concurrency: GEN_CONCURRENCY,
            retries: 2,
            stop: () => genStop.current,
            onDone: (_i, r) => {
              if (!r.ok) {
                if (r.error !== "stopped") lastErr = r.error;
                return;
              }
              const fresh = dedupeIdeas(r.value, seen).slice(0, n - got);
              if (!fresh.length) return;
              got += fresh.length;
              for (const f of fresh) used.push(f.name, f.ticker);
              ideasRef.current = [...ideasRef.current, ...fresh];
              setIdeas(ideasRef.current);
              setPicked((p) => [...p, ...fresh.map(() => true)]);
              setOriginals((o) => [...o, ...fresh]);
              setGenProgress(`Generated ${got}/${n}…`);
            },
          },
        );
        if (got === before) break;
      }
      await refresh();
      if (authErr) throw authErr;
      if (got === 0 && lastErr) throw new Error(lastErr);
      setGenProgress(got >= n ? `Generated ${got}/${n} ✓` : `Generated ${got}/${n}. ${genStop.current ? "Stopped." : lastErr ? `Some chunks failed: ${lastErr}` : "The rest came back as duplicates."}`);
    });

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
  const liveLaunches = launches?.filter((l) => !l.deletedAt) ?? null;
  const lrunCounts = lrun ? runCounts(lrun) : null;
  const walletPrompts = Math.max(1, Math.ceil(chosen.length / 10));
  const runStatus = new Map((lrun?.items ?? []).map((it) => [it.idea.ticker, it.status] as const));
  const ideaErrs = runErrors(ideas, picked, { venue: listOn });
  const invalid = ideas.map((idea, i) => ({ i, idea, e: ideaErrs[i] })).filter((x) => picked[x.i] && hasErrors(x.e));
  const editIdea = (i: number, patch: Partial<LaunchIdea>) => setIdeas((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const toggleEdit = (i: number) => setEditing((e) => { const n = new Set(e); n.has(i) ? n.delete(i) : n.add(i); return n; });
  /** One LLM call for one idea (charged like any idea); avoids the run's other names/tickers. */
  const regenIdea = async (i: number) => {
    if (!account) return;
    setRegen((r) => new Set(r).add(i));
    setError(null);
    try {
      const token = await authToken(account);
      if (!token) return;
      const others = ideasRef.current.filter((_, j) => j !== i);
      const base = prompt.trim().length >= 3 ? prompt.trim() : `${ideasRef.current[i]?.name}: ${ideasRef.current[i]?.tagline}`;
      const r = await generate(base, account, token, 1, others.flatMap((x) => [x.name, x.ticker]).slice(-24), Math.floor(Math.random() * 300));
      const seen = { names: new Set<string>(), tickers: new Set(others.map((x) => x.ticker)) };
      const fresh = dedupeIdeas([r.ideas?.[0] ?? r.idea], seen)[0] ?? r.idea;
      setIdeas((xs) => xs.map((x, j) => (j === i ? fresh : x)));
      setOriginals((o) => o.map((x, j) => (j === i ? fresh : x)));
      await refresh();
    } catch (e) {
      if (e instanceof UnauthorizedError) setSession(null);
      setError(`regenerate failed: ${friendlyWalletError(e).message}`);
    } finally {
      setRegen((r) => { const n = new Set(r); n.delete(i); return n; });
    }
  };
  const ideaProps = (idea: LaunchIdea, i: number) => ({
    idea,
    index: i,
    errors: ideaErrs[i] ?? {},
    edited: !!originals[i] && JSON.stringify(originals[i]) !== JSON.stringify(idea),
    editing: editing.has(i),
    regenerating: regen.has(i),
    onToggleEdit: () => toggleEdit(i),
    onChange: (patch: Partial<LaunchIdea>) => editIdea(i, patch),
    onReset: () => originals[i] && setIdeas((xs) => xs.map((x, j) => (j === i ? originals[i] : x))),
    onRegen: () => regenIdea(i),
    onShuffle: () => setIdeas((xs) => xs.map((x, j) => (j === i ? shufflePalette(x) : x))),
    aiCost,
  });
  const removeIdea = (i: number) => {
    setIdeas((xs) => xs.filter((_, j) => j !== i));
    setPicked((p) => p.filter((_, j) => j !== i));
    setOriginals((o) => o.filter((_, j) => j !== i));
    setEditing((e) => new Set([...e].filter((j) => j !== i).map((j) => (j > i ? j - 1 : j))));
  };

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

  const tabs = (
    <nav className="studio-tabs" role="tablist" aria-label="Studio sections">
      <button role="tab" aria-selected={tab === "studio"} onClick={() => openTab("studio")}>🏭 Studio</button>
      <button role="tab" aria-selected={tab === "tokens"} onClick={() => openTab("tokens")}>🪙 My tokens{liveLaunches?.length ? ` (${liveLaunches.length})` : ""}</button>
      {isAdmin && <button role="tab" aria-selected={tab === "admin"} onClick={() => openTab("admin")}>🛡️ Admin</button>}
    </nav>
  );

  if (tab === "tokens") {
    return (
      <>
        {tabs}
        <MyTokens
          account={session?.accountId ?? account}
          launches={launches}
          busy={busy !== null}
          progress={busy === "relist" || busy === "delete" ? progress : null}
          onReload={loadLaunches}
          onListOnRhea={(ids) => relist(ids)}
          onDelete={deleteTokens}
          onRestore={restoreTokens}
          loadPositions={loadPositions}
          notice={notice}
        />
        {error && <p className="error">{error}</p>}
      </>
    );
  }

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
        {liveLaunches === null ? (
          <p className="muted">Loading…</p>
        ) : liveLaunches.length === 0 ? (
          <p className="muted">Nothing yeeted yet. Your tokens will show up here.</p>
        ) : (
          <>
          <p className="small">
            <button className="link" onClick={() => openTab("tokens")}>Open the My tokens dashboard ({liveLaunches.length}) →</button>
          </p>
          <ul className="my-launches">
            {liveLaunches.slice(0, 8).map((l) => (
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
                      <button className="link" disabled={busy !== null} title="Send your tokens to the vault and list them on Rhea (you get the LP position)" onClick={() => relist([l.tokenId])}>
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
          {liveLaunches.length > 8 && (
            <p className="small muted">
              + {liveLaunches.length - 8} more in <button className="link" onClick={() => openTab("tokens")}>My tokens</button>
            </p>
          )}
          </>
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
            {COUNT_PRESETS.map((n) => (
              <button key={n} role="radio" aria-checked={count === n && !customCount} className={count === n && !customCount ? "on" : ""} onClick={() => (setCount(n), setCustomCount(""))}>
                {n}
              </button>
            ))}
            <input
              type="number"
              className={`count-custom${customCount ? " on" : ""}`}
              min={1}
              max={MAX_RUN}
              placeholder="custom"
              aria-label={`custom number of ideas (1-${MAX_RUN})`}
              value={customCount}
              onChange={(e) => {
                setCustomCount(e.target.value);
                if (e.target.value) setCount(clampRun(e.target.value));
              }}
              onBlur={() => customCount && setCustomCount(String(clampRun(customCount)))}
            />
          </div>
          <button disabled={busy !== null || prompt.trim().length < 3} onClick={generateRun}>
            {busy === "generate" ? "Thinking…" : count > 1 ? `Generate ${count}` : "Generate"}
          </button>
          {busy === "generate" && (
            <button className="ghost" onClick={() => (genStop.current = true)}>Stop</button>
          )}
        </div>
        <p className="muted small">
          {count} idea{count > 1 ? "s" : ""}
          {aiCost ? ` ≈ ${formatNear(BigInt(aiCost) * BigInt(count))} NEAR of credits` : ""}
          {count > MAX_BATCH ? ` · ${Math.ceil(count / MAX_BATCH)} requests of ${MAX_BATCH}, ${GEN_CONCURRENCY} at a time` : ""}
          {genProgress && <> · <strong>{genProgress}</strong></>}
        </p>
        {ideas.length === 0 && (
          <div className="idea-empty">
            <span aria-hidden="true">💡</span>
            <p>
              <strong>Your ideas land here.</strong> Describe a vibe, pick how many (up to {MAX_RUN}), and hit Generate. Each idea costs a tiny
              bit of vault credit; you can tweak tickers before launching.
            </p>
          </div>
        )}
      </section>
      {error && ideas.length === 0 && !lrun && <p className="error">{error}</p>}
      </div>
    </div>

    {ideas.length > 0 && (
      <section className="card s-ideas run-full">
        <div className="row between">
          <h2>Ideas · {chosen.length}/{ideas.length} selected</h2>
          <div className="row">
            <button className="ghost" onClick={() => setPicked(ideas.map(() => true))}>Select all</button>
            <button className="ghost" onClick={() => setPicked(ideas.map(() => false))}>None</button>
          </div>
        </div>
        <p className="muted small">
          Review before you yeet: click ✎ to edit a name, ticker, tagline, description or colours. The launch uses exactly what you see here
          (token name and symbol on chain, the site at <code>/t/&lt;slug-of-name&gt;</code> and its copy). Edits are saved in this browser.{" "}
          <button className="link" onClick={() => setEditing(editing.size ? new Set() : new Set(ideas.map((_, i) => i)))}>{editing.size ? "collapse all" : "edit all"}</button>
        </p>
        {ideas.length <= CARD_MAX ? (
          <div className="idea-grid">
            {ideas.map((idea, i) => (
              <div key={i} className="idea-cell">
                <IdeaCard
                  idea={idea}
                  picked={ideas.length > 1 ? picked[i] : undefined}
                  onPick={(v) => setPicked((p) => p.map((x, j) => (j === i ? v : x)))}
                  onTicker={(ticker) => editIdea(i, { ticker })}
                  onRemove={ideas.length > 1 ? () => removeIdea(i) : undefined}
                  onEdit={() => toggleEdit(i)}
                  bad={hasErrors(ideaErrs[i] ?? {})}
                />
                {editing.has(i) && <IdeaEditor {...ideaProps(idea, i)} />}
              </div>
            ))}
          </div>
        ) : (
          <div className="idea-rows">
            {ideas.map((idea, i) => (
              <IdeaRow
                key={i}
                {...ideaProps(idea, i)}
                picked={picked[i] ?? false}
                status={runStatus.get(idea.ticker)}
                onPick={(v) => setPicked((p) => p.map((x, j) => (j === i ? v : x)))}
                onRemove={() => removeIdea(i)}
              />
            ))}
          </div>
        )}
      </section>
    )}

      {(ideas.length > 0 || lrun) && (
        <section className="card s-launch run-full">
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
              <>Creates {chosen.length === 1 ? "a NEP-141 token" : chosen.length <= MAX_BATCH ? `${chosen.length} NEP-141 tokens in one transaction` : `${chosen.length} NEP-141 tokens in ${Math.ceil(chosen.length / MAX_BATCH)} transactions of ${MAX_BATCH}, one after another`} owned by you, paid from your vault credit (a failed item is refunded).</>
            )}
            {listOn === "rhea" && (
              <>
                Creates your token{chosen.length > 1 ? "s" : ""}, then the vault opens a Rhea DCL pool <code>token|wNEAR</code> (1% fee tier) and adds the supply
                one-sided. You get the LP position (NFT) and any tokens not in the pool, straight to your wallet. Paid from vault credit, one click.
              </>
            )}
            {listOn === "nearly" && (
              <>
                Nearly's factory creates and lists the token; your wallet signs and pays each launch ({chosen.length > 1 ? `${walletPrompts} wallet approval${walletPrompts > 1 ? "s" : ""}, up to 10 launches each` : "one prompt"}).
                Nearly locks the LP in its own locker and takes its trading fees.
              </>
            )}
            {listOn === "justhoot" && (
              <>
                JustHoot creates the token and its Rhea pool; your wallet signs and pays the exact launch deposit ({chosen.length > 1 ? `${walletPrompts} wallet approval${walletPrompts > 1 ? "s" : ""}, up to 10 launches each` : "one prompt"}).
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
            <div className="cost-wrap">
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
                  <td>Total ({q.items.length})</td>
                  <td className="muted">{q.items[0]?.paidFrom === "wallet" ? "from your wallet" : "from vault credit"}</td>
                  <td className="num">~{formatNear(BigInt(q.total))} NEAR</td>
                </tr>
              </tbody>
            </table>
            </div>
          )}
          {q?.notes?.map((n) => (
            <p key={n} className="muted small">{n}</p>
          ))}
          {!q && session && qErr && <p className="muted small">Cost estimate unavailable: {qErr}</p>}
          <div className="row">
          {invalid.length > 0 && (
            <p className="error small" role="alert">
              Fix {invalid.length} selected idea{invalid.length > 1 ? "s" : ""} before launching:{" "}
              {invalid.slice(0, 6).map((x) => `#${x.i + 1} ${x.idea.name || "(no name)"} (${Object.entries(x.e).map(([f, m]) => `${f}: ${m}`).join("; ")})`).join(" · ")}
              {invalid.length > 6 ? ` · +${invalid.length - 6} more` : ""}
            </p>
          )}
          <button disabled={busy !== null || chosen.length === 0 || invalid.length > 0} onClick={startLaunch}>
            {busy === "launch"
              ? "Launching…"
              : `${chosen.length > 1 ? `Launch ${chosen.length} tokens` : "Launch token"}${listOn === "rhea" ? " + list on Rhea" : listOn === "nearly" ? " on Nearly" : listOn === "justhoot" ? " on JustHoot" : ""}`}
          </button>
          {busy === "launch" && lrun && (
            <button className="ghost" onClick={() => (launchStop.current = true)} title="Stops after the chunk in flight">Stop after this chunk</button>
          )}
          {busy === null && lrunCounts && lrunCounts.left > 0 && (
            <button onClick={resumeRun}>Resume ({lrunCounts.left} left)</button>
          )}
          {busy === null && lrunCounts && lrunCounts.failed > 0 && (
            <button className="ghost" onClick={retryFailed}>Retry failed ({lrunCounts.failed})</button>
          )}
          </div>
          {lrun && lrunCounts && (
            <div className="run-status">
              <p>
                <strong>Launched {lrunCounts.done}/{lrunCounts.total}</strong>
                {lrunCounts.listed > 0 && <> · {lrunCounts.listed} listed</>}
                {lrunCounts.failed > 0 && <> · {lrunCounts.failed} failed</>}
                {lrunCounts.left > 0 && <> · {lrunCounts.left} to go</>} <span className="muted small">({lrun.venue === "none" ? "token only" : lrun.venue}, started {fmtWhen(lrun.startedAt)})</span>{" "}
                {busy === null && lrunCounts.left === 0 && (
                  <button className="link" onClick={() => setRun(null)}>clear</button>
                )}
              </p>
              <progress max={lrunCounts.total} value={lrunCounts.done + lrunCounts.failed} />
              <ul className="run-items">
                {lrun.items.map((it) => (
                  <RunRow key={it.idea.ticker} it={it} />
                ))}
              </ul>
            </div>
          )}
          {progress && <p className="muted small">{progress}</p>}
          {error && <p className="error">{error}</p>}
          {result && !lrun && (
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
    </>
  );
}

const STATUS_LABEL: Record<RunItem["status"], string> = {
  pending: "⏳ waiting",
  sending: "🚀 launching",
  signing: "✍️ in wallet",
  ok: "✅ ok",
  listed: "✅ listed",
  failed: "❌ failed",
};

function RunRow({ it }: { it: RunItem }) {
  const done = it.status === "ok" || it.status === "listed";
  return (
    <li className={`run-${it.status}`}>
      <span className="run-st">{STATUS_LABEL[it.status]}</span> <strong>${it.idea.ticker.toUpperCase()}</strong>{" "}
      {done && <a href={`/t/${it.slug ?? it.idea.ticker}`}>site</a>}
      {it.listingUrl && (
        <>
          {" "}· <a href={it.listingUrl} target="_blank" rel="noreferrer">pool ↗</a>
        </>
      )}
      {it.status === "failed" && <span className="muted small"> {it.error ?? "failed"}{/refund/i.test(it.error ?? "") ? "" : " (refunded)"}</span>}
      {it.listingError && <span className="muted small"> listing: {it.listingError}</span>}
    </li>
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
  onRemove,
  onEdit,
  bad,
}: {
  idea: LaunchIdea;
  onTicker: (t: string) => void;
  picked?: boolean;
  onPick: (v: boolean) => void;
  onRemove?: () => void;
  onEdit?: () => void;
  bad?: boolean;
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
        {bad && <span className="err-inline small" style={{ marginLeft: "auto" }}>⚠ fix</span>}
        {onEdit && (
          <button className="link idea-x" style={{ color: c.text, marginLeft: bad ? undefined : "auto" }} onClick={onEdit} aria-label={`edit ${idea.name}`}>
            ✎ edit
          </button>
        )}
        {onRemove && (
          <button className="link idea-x" style={{ color: c.text }} onClick={onRemove} aria-label={`remove ${idea.name}`}>
            remove
          </button>
        )}
      </div>
    </div>
  );
}

type IdeaEditProps = {
  idea: LaunchIdea;
  index: number;
  errors: IdeaErrors;
  edited: boolean;
  editing: boolean;
  regenerating: boolean;
  aiCost: string | null;
  onToggleEdit: () => void;
  onChange: (patch: Partial<LaunchIdea>) => void;
  onReset: () => void;
  onRegen: () => void;
  onShuffle: () => void;
};

const cleanTicker = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);

/** Inline editor for every launch field of an idea (name, ticker, tagline, description, colours). */
function IdeaEditor({ idea, index, errors, edited, regenerating, aiCost, onChange, onReset, onRegen, onShuffle }: IdeaEditProps) {
  const id = `idea-${index}`;
  const err = (f: keyof IdeaErrors) => errors[f] && <span className="err-inline small" id={`${id}-${f}-err`}>{errors[f]}</span>;
  const field = (f: keyof IdeaErrors) => ({ "aria-invalid": !!errors[f], "aria-describedby": errors[f] ? `${id}-${f}-err` : undefined });
  return (
    <div className="idea-edit">
      <label>
        Name <span className="muted small">{idea.name.length}/40 · site /t/{slugPreview(idea.name) || idea.ticker}</span>
        <input value={idea.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} {...field("name")} data-field="name" />
        {err("name")}
      </label>
      <label>
        Ticker / symbol <span className="muted small">${idea.ticker.toUpperCase()}</span>
        <input value={idea.ticker} maxLength={16} onChange={(e) => onChange({ ticker: cleanTicker(e.target.value) })} {...field("ticker")} data-field="ticker" />
        {err("ticker")}
      </label>
      <label className="wide">
        Tagline <span className="muted small">{idea.tagline.length}/120</span>
        <input value={idea.tagline} maxLength={140} onChange={(e) => onChange({ tagline: e.target.value })} {...field("tagline")} data-field="tagline" />
        {err("tagline")}
      </label>
      <label className="wide">
        Description <span className="muted small">{idea.description.length}/600</span>
        <textarea rows={3} value={idea.description} maxLength={700} onChange={(e) => onChange({ description: e.target.value })} {...field("description")} data-field="description" />
        {err("description")}
      </label>
      <div className="wide ie-colors">
        <span className="small">Colours</span>
        {(Object.keys(idea.colors) as (keyof LaunchIdea["colors"])[]).map((k) => (
          <label key={k} className="small ie-color" title={k}>
            <input type="color" value={idea.colors[k]} onChange={(e) => onChange({ colors: { ...idea.colors, [k]: e.target.value } })} aria-label={`${k} colour`} />
            {k}
          </label>
        ))}
        {err("colors")}
      </div>
      <div className="wide row ie-actions">
        <button className="ghost mini" disabled={regenerating} onClick={onRegen} title="One new AI idea for this slot">
          {regenerating ? "Regenerating…" : `↻ Regenerate idea${aiCost ? ` (${formatNear(BigInt(aiCost), 2)} NEAR)` : ""}`}
        </button>
        <button className="ghost mini" onClick={onShuffle} title="The icon is drawn from the ticker and colours; this rotates the colours (free)">🎨 New icon colours</button>
        <button className="ghost mini" disabled={!edited} onClick={onReset}>Reset to original</button>
      </div>
    </div>
  );
}

const slugPreview = (name: string) =>
  name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");

/** Light row for big runs: small SVG icon (re-rendered from the edited ticker/colours), name, ticker, tagline; ✎ expands the editor. */
function IdeaRow(props: IdeaEditProps & { picked: boolean; status?: RunItem["status"]; onPick: (v: boolean) => void; onRemove: () => void }) {
  const { idea, picked, status, errors, editing, edited, onPick, onRemove, onToggleEdit, onChange } = props;
  const bad = hasErrors(errors);
  return (
    <div className={`idea-row${picked ? "" : " off"}${editing ? " open" : ""}${bad ? " bad" : ""}`}>
      <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`launch ${idea.name}`} />
      <img src={tokenIconDataUri(idea)} alt="" width={36} height={36} loading="lazy" />
      <div className="ir-body">
        <div className="ir-top">
          <strong className="ir-name" title={idea.description}>{idea.name || <em className="muted">no name</em>}</strong>
          <span className="ir-tk">
            $
            <input value={idea.ticker} maxLength={16} onChange={(e) => onChange({ ticker: cleanTicker(e.target.value) })} aria-label={`ticker for ${idea.name}`} aria-invalid={!!errors.ticker} />
          </span>
          {edited && <span className="badge small">edited</span>}
          {status && <span className="small">{STATUS_LABEL[status]}</span>}
        </div>
        <span className="ir-tag muted small">{idea.tagline}</span>
        {bad && !editing && <span className="err-inline small">⚠ {Object.entries(errors).map(([f, m]) => `${f}: ${m}`).join("; ")}</span>}
      </div>
      <div className="ir-act">
        <button className="link ir-x" onClick={onToggleEdit} aria-expanded={editing} aria-label={`edit ${idea.name}`} title="Edit">{editing ? "▴" : "✎"}</button>
        <button className="link ir-x" onClick={onRemove} aria-label={`remove ${idea.name}`} title="Remove">✕</button>
      </div>
      {editing && <IdeaEditor {...props} />}
    </div>
  );
}

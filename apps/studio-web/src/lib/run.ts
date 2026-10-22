import type { BatchLaunchItem, LaunchedToken, LaunchIdea, NearlyLaunchTx, RheaOptions } from "@osl/schema";

/**
 * A multi-token launch run (up to MAX_RUN), persisted in localStorage so a redirect wallet or a tab reload
 * doesn't lose what already launched; the rest can be resumed.
 */
export type RunVenue = "none" | "rhea" | "nearly" | "justhoot";
export type ItemStatus = "pending" | "sending" | "signing" | "ok" | "listed" | "failed";
export interface RunItem {
  idea: LaunchIdea;
  status: ItemStatus;
  tokenId?: string | null;
  slug?: string | null;
  error?: string | null;
  /** Rhea/Nearly/JustHoot page, when listed. */
  listingUrl?: string | null;
  listingError?: string | null;
  txHash?: string | null;
  /** Wallet venues: the prepared call, kept so a resume doesn't re-prepare. */
  tx?: NearlyLaunchTx;
}
export interface LaunchRun {
  v: 1;
  account: string;
  venue: RunVenue;
  rhea?: RheaOptions;
  startedAt: number;
  /** Wallet venues: calls per wallet prompt (from prepare). */
  walletChunk?: number;
  items: RunItem[];
}

export const RUN_KEY = "yeetpad.launchRun";

export function loadRun(account: string): LaunchRun | null {
  try {
    const r = JSON.parse(localStorage.getItem(RUN_KEY) ?? "null") as LaunchRun | null;
    return r && r.v === 1 && r.account === account && Array.isArray(r.items) ? r : null;
  } catch {
    return null;
  }
}
export function saveRun(run: LaunchRun | null) {
  try {
    if (run) localStorage.setItem(RUN_KEY, JSON.stringify(run));
    else localStorage.removeItem(RUN_KEY);
  } catch {}
}

export const newRun = (account: string, venue: RunVenue, ideas: LaunchIdea[], rhea?: RheaOptions): LaunchRun => ({
  v: 1,
  account,
  venue,
  ...(venue === "rhea" ? { rhea } : {}),
  startedAt: Date.now(),
  items: ideas.map((idea) => ({ idea, status: "pending" })),
});

export const isDone = (s: ItemStatus) => s === "ok" || s === "listed";
export const runCounts = (run: LaunchRun) => {
  const c = { total: run.items.length, done: 0, failed: 0, left: 0, listed: 0 };
  for (const it of run.items) {
    if (isDone(it.status)) c.done++;
    if (it.status === "listed") c.listed++;
    if (it.status === "failed") c.failed++;
    if (it.status === "pending" || it.status === "sending" || it.status === "signing") c.left++;
  }
  return c;
};

/** Applies a batch-launch / finalize result to the run's items (by ticker). */
export function applyResults(run: LaunchRun, results: BatchLaunchItem[], txHash?: string | null): LaunchRun {
  const by = new Map(results.map((r) => [r.ticker, r]));
  return {
    ...run,
    items: run.items.map((it) => {
      const r = by.get(it.idea.ticker);
      if (!r) return it;
      if (!r.ok) return { ...it, status: "failed", error: r.error ?? "launch failed; refunded" };
      const listed = r.listing?.ok === true;
      return {
        ...it,
        status: listed ? "listed" : "ok",
        tokenId: r.tokenId,
        slug: r.slug ?? null,
        error: null,
        txHash: txHash ?? r.listing?.txHash ?? it.txHash ?? null,
        listingUrl: listed ? (r.listing?.url ?? null) : null,
        listingError: r.listing && !r.listing.ok ? r.listing.error : null,
      } as RunItem;
    }),
  };
}

/**
 * After a reload or redirect: items that were in flight (sending/signing) or pending but are already in
 * "My launches" are marked done; other in-flight items go back to pending so they can be resumed.
 */
export function reconcile(run: LaunchRun, launches: LaunchedToken[], since = run.startedAt - 60_000): LaunchRun {
  const mine = new Map(launches.filter((l) => l.createdAt >= since).map((l) => [l.ticker, l]));
  return {
    ...run,
    items: run.items.map((it) => {
      if (isDone(it.status)) return it;
      const l = mine.get(it.idea.ticker);
      if (l) {
        const listed = l.venue !== undefined && l.venue !== "yeetpad";
        return { ...it, status: listed ? "listed" : "ok", tokenId: l.tokenId, slug: l.slug, listingUrl: listed ? (l.venueUrl ?? null) : null, error: null, txHash: it.txHash ?? l.txHash ?? null };
      }
      return it.status === "sending" || it.status === "signing" ? { ...it, status: "pending" } : it;
    }),
  };
}

/** Marks the given tickers with a status (and optional error). */
export function mark(run: LaunchRun, tickers: string[], status: ItemStatus, error?: string): LaunchRun {
  const s = new Set(tickers);
  return { ...run, items: run.items.map((it) => (s.has(it.idea.ticker) ? { ...it, status, ...(error !== undefined ? { error } : {}) } : it)) };
}

// ---- pre-launch draft: generated ideas plus the creator's edits ----
export const DRAFT_KEY = "yeetpad.ideasDraft";
export interface IdeasDraft {
  v: 1;
  account: string;
  prompt: string;
  ideas: LaunchIdea[];
  originals: LaunchIdea[];
  picked: boolean[];
}
export function loadDraft(account: string): IdeasDraft | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as IdeasDraft | null;
    if (!d || d.v !== 1 || d.account !== account || !Array.isArray(d.ideas) || !d.ideas.length) return null;
    const n = d.ideas.length;
    return { ...d, picked: Array.from({ length: n }, (_, i) => d.picked?.[i] ?? true), originals: Array.from({ length: n }, (_, i) => d.originals?.[i] ?? d.ideas[i]) };
  } catch {
    return null;
  }
}
export function saveDraft(account: string, d: Omit<IdeasDraft, "v" | "account">) {
  try {
    if (!d.ideas.length) {
      const cur = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
      if (cur?.account === account) localStorage.removeItem(DRAFT_KEY);
      return;
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, account, ...d }));
  } catch {}
}

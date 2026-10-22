import type {
  AdminAllowedItem,
  AdminResult,
  AdminWaitlistItem,
  BatchLaunchResponse,
  GenerateResponse,
  LaunchedToken,
  LaunchIdea,
  LaunchResponse,
  MeResponse,
  JusthootFinalizeResponse,
  JusthootPrepareResponse,
  NearlyFinalizeResponse,
  NearlyPrepareResponse,
  QuoteResponse,
  RheaOptions,
  SiteConfig,
} from "@osl/schema";
import { MAX_BATCH, chunk, pool } from "@osl/schema";
import { API_URL } from "./config";
import { NotWhitelistedError, clearSession, isNotWhitelisted } from "./auth";

export class UnauthorizedError extends Error {}
export { NotWhitelistedError };

/** 401 -> session gone; 403 not_whitelisted -> locked out; other errors -> Error. */
function check(r: Response, j: { error?: string; code?: string }) {
  if (r.status === 401) {
    clearSession();
    throw new UnauthorizedError(j.error ?? "session expired; verify your wallet again");
  }
  if (isNotWhitelisted(r.status, j)) {
    clearSession();
    throw new NotWhitelistedError(null, j.error);
  }
  if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status, j);
}

/** Non-2xx API answer; `noRetry` marks client errors (bad input, no credit, auth) that a retry won't fix. */
export class ApiError extends Error {
  noRetry: boolean;
  constructor(message: string, public status: number, public body: { error?: string; taken?: string[]; [k: string]: unknown }) {
    super(message);
    this.noRetry = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

async function post<T>(path: string, body: unknown, token: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  check(r, j);
  return j as T;
}

export const generate = (prompt: string, ownerWallet: string, token: string, count = 1, avoid: string[] = [], seq?: number) =>
  post<GenerateResponse>("/api/generate", { prompt, ownerWallet, count, ...(avoid.length ? { avoid } : {}), ...(seq !== undefined ? { seq } : {}) }, token);

/** Credits charged per generated idea (yoctoNEAR), from /api/health. */
export const aiComputeCost = () => get<{ aiComputeCost?: string }>("/api/health").then((h) => h.aiComputeCost ?? "10000000000000000000000");

export type ListOnChoice = "none" | "rhea" | "nearly" | "justhoot";

export const launchBatch = (ownerWallet: string, ideas: LaunchIdea[], token: string, listOn: "none" | "rhea" = "none", rhea?: RheaOptions) =>
  post<BatchLaunchResponse>("/api/launch/batch", { ownerWallet, ideas, listOn, ...(listOn === "rhea" ? { rhea } : {}) }, token);

type VenueFlag = { enabled: boolean; reason: string | null };
export async function venueStatus(account?: string | null): Promise<{ nearly: VenueFlag; justhoot: VenueFlag }> {
  type H = { enabled?: boolean; reason?: string | null };
  const j = await get<{ venues?: { nearly?: H; justhoot?: H } }>("/api/health").catch(() => ({}) as never);
  const nearly = { enabled: j?.venues?.nearly?.enabled === true, reason: j?.venues?.nearly?.reason ?? "Nearly is not available" };
  let justhoot: VenueFlag = { enabled: false, reason: j?.venues?.justhoot?.reason ?? "mainnet only, enabled at mainnet launch" };
  // Flag on: ask the launcher too (is_public_launch / whitelisted creator).
  if (j?.venues?.justhoot?.enabled) {
    justhoot = await get<VenueFlag>(`/api/justhoot/status${account ? `?account=${encodeURIComponent(account)}` : ""}`).catch(() => ({ enabled: false, reason: "JustHoot status unavailable" }));
  }
  return { nearly, justhoot };
}

export const quoteOne = (ideas: LaunchIdea[], listOn: ListOnChoice, token: string, rhea?: RheaOptions, icons?: Record<string, string>) =>
  post<QuoteResponse>("/api/quote", { ideas, listOn, ...(listOn === "rhea" ? { rhea } : {}), ...(icons ? { icons } : {}) }, token);

/** Quote a whole run: MAX_BATCH ideas per request (the API's cap), 3 at a time, merged into one answer. */
export async function quote(ideas: LaunchIdea[], listOn: ListOnChoice, token: string, rhea?: RheaOptions, icons?: Record<string, string>): Promise<QuoteResponse> {
  const parts = chunk(ideas, MAX_BATCH);
  const res = await pool(
    parts.map((p) => () => quoteOne(p, listOn, token, rhea, icons && Object.fromEntries(p.filter((i) => icons[i.ticker]).map((i) => [i.ticker, icons[i.ticker]])))),
    { concurrency: 3, retries: 1 },
  );
  const bad = res.find((r) => !r.ok);
  if (bad && !bad.ok) throw new Error(bad.error);
  const qs = res.map((r) => (r as { ok: true; value: QuoteResponse }).value);
  // Only the run's first item can carry Rhea's one-time DCL storage; later chunks re-quote it as "first".
  const items = qs.flatMap((q, k) =>
    k === 0 ? q.items : q.items.map((it, j) => (j === 0 && it.parts.dcl_storage_first_time ? dropFirstDcl(it) : it)),
  );
  const total = items.reduce((t, it) => t + BigInt(it.total), 0n).toString();
  return { ...qs[0], items, total, notes: [...new Set(qs.flatMap((q) => q.notes))] };
}
function dropFirstDcl(it: QuoteResponse["items"][number]): QuoteResponse["items"][number] {
  const { dcl_storage_first_time: dcl, ...parts } = it.parts;
  return { ...it, parts, total: (BigInt(it.total) - BigInt(dcl ?? "0")).toString() };
}

export const listOnRhea = (tokenId: string, token: string, rhea?: RheaOptions) =>
  post<{ listing: import("@osl/schema").Listing }>("/api/list/rhea", { tokenId, ...(rhea ? { rhea } : {}) }, token);

export const nearlyPrepare = (ideas: LaunchIdea[], token: string) => post<NearlyPrepareResponse>("/api/nearly/prepare", { ideas }, token);

export const nearlyFinalize = (items: { ticker: string; txHash: string }[], token: string) => finalizeChunked("/api/nearly/finalize", items, token);

/** Finalize takes MAX_BATCH items per request; a wallet prompt signs up to 10, so split and merge. */
async function finalizeChunked(path: string, items: { ticker: string; txHash: string }[], token: string): Promise<NearlyFinalizeResponse> {
  const results: NearlyFinalizeResponse["results"] = [];
  for (const part of chunk(items, MAX_BATCH)) {
    try {
      results.push(...(await post<NearlyFinalizeResponse>(path, { items: part }, token)).results);
    } catch (e) {
      const r = (e as ApiError).body?.results as NearlyFinalizeResponse["results"] | undefined;
      if (r?.length) results.push(...r);
      else if (e instanceof UnauthorizedError) throw e;
      else results.push(...part.map((p) => ({ ticker: p.ticker, ok: false, tokenId: null, slug: null, siteUrl: null, error: (e as Error).message, listing: null })));
    }
  }
  return { results };
}

export async function saveSiteSettings(id: string, gaId: string | null, token: string) {
  const r = await fetch(`${API_URL}/api/site/${encodeURIComponent(id)}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ gaId }),
  });
  const j = await r.json().catch(() => ({}));
  check(r, j);
  return j as { ok: true; ticker: string; gaId: string | null };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

/** All of an account's launches: pages through the factory registry (50 per page), newest first. */
export async function myLaunches(account: string): Promise<{ account: string; launches: LaunchedToken[] }> {
  const PAGE = 50;
  const all: LaunchedToken[] = [];
  for (let from = 0, page = 0; page < 40; page++, from += PAGE) {
    const r = await get<{ account: string; launches: LaunchedToken[] }>(`/api/launches/${encodeURIComponent(account)}?from=${from}&limit=${PAGE}`);
    all.push(...r.launches);
    // Nearly/JustHoot entries come from a KV index on the first page only; count factory tokens for paging.
    if (r.launches.filter((l) => l.venue !== "nearly" && l.venue !== "justhoot").length < PAGE) break;
  }
  const seen = new Set<string>();
  const launches = all.filter((l) => !seen.has(l.tokenId) && seen.add(l.tokenId)).sort((a, b) => b.createdAt - a.createdAt);
  return { account, launches };
}

export const fetchSite = (ticker: string) =>
  get<{ source: string; siteConfig: SiteConfig; siteUrl: string }>(`/api/site/${encodeURIComponent(ticker)}`);

export const launch = (ownerWallet: string, idea: LaunchIdea, token: string) =>
  post<LaunchResponse>("/api/launch", { ownerWallet, idea }, token);

/** Is the app locked (whitelist only)? Fails closed: an unreachable API counts as locked. */
export async function appLocked(): Promise<boolean> {
  try {
    const j = await get<{ locked?: boolean }>("/api/health");
    return j.locked !== false;
  } catch {
    return true;
  }
}


async function authed<T>(method: "GET" | "POST", path: string, token: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({}));
  check(r, j);
  return j as T;
}

/** Who am I (session account, admin flag, allowlist status). */
export const me = (token: string) => authed<MeResponse>("GET", "/api/auth/me", token);

// ---------- admin (ADMIN_ACCOUNTS only; others get 403 not_admin) ----------
export type WaitlistCounts = { total: number; pending: number; approved: number; revoked: number };
export const adminWaitlist = (token: string) =>
  authed<{ entries: AdminWaitlistItem[]; counts: WaitlistCounts; allowed: AdminAllowedItem[]; truncated: boolean }>("GET", "/api/admin/waitlist", token);
export const adminAllowed = (token: string) => authed<{ allowed: AdminAllowedItem[]; truncated: boolean }>("GET", "/api/admin/allowed", token);
export const adminAction = (action: "approve" | "revoke" | "remove", accounts: string[], token: string) =>
  authed<{ results: AdminResult[] }>("POST", `/api/admin/${action}`, token, { accounts });

export const justhootPrepare = (ideas: LaunchIdea[], icons: Record<string, string>, token: string) =>
  post<JusthootPrepareResponse>("/api/justhoot/prepare", { ideas, icons }, token);

export const justhootFinalize = (items: { ticker: string; txHash: string }[], token: string): Promise<JusthootFinalizeResponse> =>
  finalizeChunked("/api/justhoot/finalize", items, token);

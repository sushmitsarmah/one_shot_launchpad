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
  NearlyFinalizeResponse,
  NearlyPrepareResponse,
  QuoteResponse,
  RheaOptions,
  SiteConfig,
} from "@osl/schema";
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
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
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

export const generate = (prompt: string, ownerWallet: string, token: string, count = 1) =>
  post<GenerateResponse>("/api/generate", { prompt, ownerWallet, count }, token);

export type ListOnChoice = "none" | "rhea" | "nearly";

export const launchBatch = (ownerWallet: string, ideas: LaunchIdea[], token: string, listOn: "none" | "rhea" = "none", rhea?: RheaOptions) =>
  post<BatchLaunchResponse>("/api/launch/batch", { ownerWallet, ideas, listOn, ...(listOn === "rhea" ? { rhea } : {}) }, token);

export const quote = (ideas: LaunchIdea[], listOn: ListOnChoice, token: string, rhea?: RheaOptions) =>
  post<QuoteResponse>("/api/quote", { ideas, listOn, ...(listOn === "rhea" ? { rhea } : {}) }, token);

export const nearlyPrepare = (ideas: LaunchIdea[], token: string) => post<NearlyPrepareResponse>("/api/nearly/prepare", { ideas }, token);

export const nearlyFinalize = (items: { ticker: string; txHash: string }[], token: string) =>
  post<NearlyFinalizeResponse>("/api/nearly/finalize", { items }, token);

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

export const myLaunches = (account: string) =>
  get<{ account: string; launches: LaunchedToken[] }>(`/api/launches/${encodeURIComponent(account)}`);

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

import type { BatchLaunchResponse, GenerateResponse, LaunchedToken, LaunchIdea, LaunchResponse, SiteConfig } from "@osl/schema";
import { API_URL } from "./config";
import { clearSession } from "./auth";

export class UnauthorizedError extends Error {}

async function post<T>(path: string, body: unknown, token: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) {
    clearSession();
    throw new UnauthorizedError(j.error ?? "session expired; verify your wallet again");
  }
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export const generate = (prompt: string, ownerWallet: string, token: string, count = 1) =>
  post<GenerateResponse>("/api/generate", { prompt, ownerWallet, count }, token);

export const launchBatch = (ownerWallet: string, ideas: LaunchIdea[], token: string) =>
  post<BatchLaunchResponse>("/api/launch/batch", { ownerWallet, ideas }, token);

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

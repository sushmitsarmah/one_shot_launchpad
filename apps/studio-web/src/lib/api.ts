import type { GenerateResponse, LaunchIdea, LaunchResponse } from "@osl/schema";
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

export const generate = (prompt: string, ownerWallet: string, token: string) =>
  post<GenerateResponse>("/api/generate", { prompt, ownerWallet }, token);

export const launch = (ownerWallet: string, idea: LaunchIdea, token: string) =>
  post<LaunchResponse>("/api/launch", { ownerWallet, idea }, token);

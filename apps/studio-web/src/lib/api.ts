import type { GenerateResponse, LaunchIdea, LaunchResponse } from "@osl/schema";
import { API_URL } from "./config";

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export const generate = (prompt: string, ownerWallet: string) =>
  post<GenerateResponse>("/api/generate", { prompt, ownerWallet });

export const launch = (ownerWallet: string, idea: LaunchIdea) =>
  post<LaunchResponse>("/api/launch", { ownerWallet, idea });

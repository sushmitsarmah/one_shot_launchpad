/**
 * Access gate + whitelist (waitlist) signups.
 *
 * While `config.locked` (env LOCKED, default on) only accounts in ALLOWED_ACCOUNTS may get a session
 * or call the endpoints that spend credits / launch / change site settings. Everyone else can join
 * the waitlist: POST /api/whitelist stores `waitlist:<account>` in the SITES KV namespace.
 */
import { NOT_WHITELISTED, type WaitlistRequest } from "@osl/schema";
import { AuthError } from "./auth";
import type { KVLike } from "./sites";

export interface GateConfig {
  locked: boolean;
  allowedAccounts: string[];
}

/** True if `account` may use the app under `cfg`. */
export function isAllowed(account: string, cfg: GateConfig): boolean {
  if (!cfg.locked) return true;
  return cfg.allowedAccounts.includes(account.trim().toLowerCase());
}

/** Throws a 403 `not_whitelisted` AuthError unless `account` is allowed. */
export function assertAllowed(account: string, cfg: GateConfig): void {
  if (!isAllowed(account, cfg)) {
    throw new AuthError(`${account} is not on the whitelist yet. Join the waitlist and we'll let you in soon.`, 403, NOT_WHITELISTED);
  }
}

// ---------- waitlist ----------
export const WAITLIST_PREFIX = "waitlist:";
export const waitlistKey = (account: string) => `${WAITLIST_PREFIX}${account}`;
/** Max request body for POST /api/whitelist. */
export const WAITLIST_MAX_BODY = 1024;
/** Per-IP signups per window. */
export const WAITLIST_RATE_LIMIT = 10;
export const WAITLIST_RATE_WINDOW_S = 3600;

export interface WaitlistEntry {
  account: string;
  contact: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Idempotent: the first signup's timestamp is kept; a later signup only rewrites the entry when it
 * brings a new contact. Returns `already: true` when the account was on the list before.
 */
export async function addToWaitlist(kv: KVLike, req: WaitlistRequest, now = Date.now()): Promise<{ entry: WaitlistEntry; already: boolean }> {
  const key = waitlistKey(req.account);
  const contact = req.contact ? req.contact : null;
  const raw = await kv.get(key);
  if (raw) {
    let prev: WaitlistEntry | null = null;
    try {
      prev = JSON.parse(raw) as WaitlistEntry;
    } catch {}
    if (prev) {
      if (contact && contact !== prev.contact) {
        const entry = { ...prev, contact, updatedAt: now };
        await kv.put(key, JSON.stringify(entry));
        return { entry, already: true };
      }
      return { entry: prev, already: true };
    }
  }
  const entry: WaitlistEntry = { account: req.account, contact, createdAt: now, updatedAt: now };
  await kv.put(key, JSON.stringify(entry));
  return { entry, already: false };
}

/**
 * Fixed-window per-IP counter in KV (`wlrl:<ip>:<window>`, auto-expiring). KV is eventually
 * consistent, so this is a soft limit that stops casual spam, not a hard guarantee.
 * Returns true if the request is allowed (and counts it).
 */
export async function takeRateLimit(
  kv: KVLike,
  ip: string,
  now = Date.now(),
  limit = WAITLIST_RATE_LIMIT,
  windowS = WAITLIST_RATE_WINDOW_S,
): Promise<boolean> {
  const window = Math.floor(now / 1000 / windowS);
  const key = `wlrl:${ip}:${window}`;
  const n = Number((await kv.get(key)) ?? 0) || 0;
  if (n >= limit) return false;
  await kv.put(key, String(n + 1), { expirationTtl: Math.max(60, windowS * 2) });
  return true;
}

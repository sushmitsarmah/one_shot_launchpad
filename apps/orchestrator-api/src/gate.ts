/**
 * Access gate, whitelist (waitlist) signups and admin approvals.
 *
 * While `config.locked` (env LOCKED, default on) only allowlisted accounts may get a session or call the
 * endpoints that spend credits / launch / change site settings. The allowlist is the union of:
 *   - ADMIN_ACCOUNTS (env; admins are implicitly allowed),
 *   - ALLOWED_ACCOUNTS (env; bootstrap/fallback),
 *   - KV `allow:<account>` -> {approvedAt, approvedBy}, written by admins via /api/admin/approve.
 * Everyone else can join the waitlist: POST /api/whitelist stores `waitlist:<account>` in KV.
 */
import { NOT_ADMIN, NOT_WHITELISTED, type AdminAllowedItem, type AdminResult, type AdminWaitlistItem, type WaitlistRequest } from "@osl/schema";
import { AuthError } from "./auth";
import { getMany, type KVLike } from "./sites";

export interface GateConfig {
  locked: boolean;
  allowedAccounts: string[];
  adminAccounts?: string[];
}

const norm = (a: string) => a.trim().toLowerCase();
/** KV read cache for allow: lookups (seconds; Workers KV minimum). Approvals/revokes apply within ~30 s. */
export const ALLOW_CACHE_TTL_S = 30;

export const isAdmin = (account: string, cfg: GateConfig) => (cfg.adminAccounts ?? []).includes(norm(account));
/** Allowed by env vars alone (admins + ALLOWED_ACCOUNTS); no KV lookup. */
export const isEnvAllowed = (account: string, cfg: GateConfig) => isAdmin(account, cfg) || cfg.allowedAccounts.includes(norm(account));

export const ALLOW_PREFIX = "allow:";
export const allowKey = (account: string) => `${ALLOW_PREFIX}${norm(account)}`;
export interface AllowEntry {
  approvedAt: number;
  approvedBy: string;
}

/** True if `account` is on the allowlist (env or KV), regardless of LOCKED. */
export async function isWhitelisted(account: string, cfg: GateConfig, kv: KVLike): Promise<boolean> {
  if (isEnvAllowed(account, cfg)) return true;
  return (await kv.get(allowKey(account), { cacheTtl: ALLOW_CACHE_TTL_S })) !== null;
}

/** True if `account` may use the app under `cfg` (everyone when unlocked). */
export async function isAllowed(account: string, cfg: GateConfig, kv: KVLike): Promise<boolean> {
  if (!cfg.locked) return true;
  return isWhitelisted(account, cfg, kv);
}

/** Throws a 403 `not_whitelisted` AuthError unless `account` is allowed. */
export async function assertAllowed(account: string, cfg: GateConfig, kv: KVLike): Promise<void> {
  if (!(await isAllowed(account, cfg, kv))) {
    throw new AuthError(`${account} is not on the whitelist yet. Join the waitlist and we'll let you in soon.`, 403, NOT_WHITELISTED);
  }
}

export function assertAdmin(account: string, cfg: GateConfig): void {
  if (!isAdmin(account, cfg)) throw new AuthError("admins only", 403, NOT_ADMIN);
}

// ---------- waitlist ----------
export const WAITLIST_PREFIX = "waitlist:";
export const waitlistKey = (account: string) => `${WAITLIST_PREFIX}${norm(account)}`;
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
  /** Set by admins. Effective access is always decided by the allowlist, not by this field. */
  status?: "pending" | "approved" | "revoked";
  approvedAt?: number;
  approvedBy?: string;
  revokedAt?: number;
}

/** Entries are also written as KV metadata, so `wrangler kv key list --prefix waitlist:` shows them inline. */
const putEntry = (kv: KVLike, e: WaitlistEntry) => kv.put(waitlistKey(e.account), JSON.stringify(e), { metadata: e });

async function getEntry(kv: KVLike, account: string): Promise<WaitlistEntry | null> {
  const raw = await kv.get(waitlistKey(account));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WaitlistEntry;
  } catch {
    return null;
  }
}

/**
 * Idempotent: the first signup's timestamp is kept; a later signup only rewrites the entry when it
 * brings a new contact. Returns `already: true` when the account was on the list before.
 */
export async function addToWaitlist(kv: KVLike, req: WaitlistRequest, now = Date.now()): Promise<{ entry: WaitlistEntry; already: boolean }> {
  const contact = req.contact ? req.contact : null;
  const prev = await getEntry(kv, req.account);
  if (prev) {
    if (contact && contact !== prev.contact) {
      const entry = { ...prev, contact, updatedAt: now };
      await putEntry(kv, entry);
      return { entry, already: true };
    }
    return { entry: prev, already: true };
  }
  const entry: WaitlistEntry = { account: norm(req.account), contact, createdAt: now, updatedAt: now, status: "pending" };
  await putEntry(kv, entry);
  return { entry, already: false };
}

/** All keys under `prefix`, following KV list cursors (max `maxPages` × 1000 keys). */
export async function listAll(kv: KVLike, prefix: string, maxPages = 20): Promise<{ keys: { name: string; metadata?: unknown }[]; truncated: boolean }> {
  if (!kv.list) throw new Error("KV store does not support list()");
  const keys: { name: string; metadata?: unknown }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await kv.list({ prefix, cursor });
    keys.push(...r.keys);
    if (r.list_complete || !r.cursor) return { keys, truncated: false };
    cursor = r.cursor;
  }
  return { keys, truncated: true };
}


const parse = <T>(raw: string | null | undefined): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/**
 * KV list() is eventually consistent (results can lag writes by ~60 s), so list() is only used to find
 * keys; values and allow: state are re-read with (bulk) get, which sees recent writes.
 */
async function freshWaitlist(kv: KVLike): Promise<{ entries: WaitlistEntry[]; allow: Map<string, AllowEntry>; truncated: boolean }> {
  const wl = await listAll(kv, WAITLIST_PREFIX);
  const names = wl.keys.map((k) => k.name);
  const accounts = names.map((n) => n.slice(WAITLIST_PREFIX.length));
  const [values, allows] = await Promise.all([getMany(kv, names), getMany(kv, accounts.map(allowKey))]);
  const entries: WaitlistEntry[] = [];
  const allow = new Map<string, AllowEntry>();
  for (const a of accounts) {
    const e = parse<WaitlistEntry>(values.get(waitlistKey(a))); // null = removed since the list was cached
    if (e) entries.push(e);
    const al = parse<AllowEntry>(allows.get(allowKey(a)));
    if (al) allow.set(a, al);
  }
  return { entries, allow, truncated: wl.truncated };
}

/** Everyone on the allowlist: admins, ALLOWED_ACCOUNTS and KV approvals. */
export async function listAllowed(kv: KVLike, cfg: GateConfig, fresh?: Map<string, AllowEntry>): Promise<{ allowed: AdminAllowedItem[]; truncated: boolean }> {
  const { keys, truncated } = await listAll(kv, ALLOW_PREFIX);
  const listed = keys.map((k) => k.name.slice(ALLOW_PREFIX.length));
  const values = await getMany(kv, listed.map(allowKey));
  const out = new Map<string, AdminAllowedItem>();
  const add = (account: string, e: AllowEntry) =>
    out.set(account, { account, source: "kv", approvedAt: e.approvedAt ?? null, approvedBy: e.approvedBy ?? null });
  for (const a of listed) {
    const e = parse<AllowEntry>(values.get(allowKey(a))); // null = revoked since the list was cached
    if (e) add(a, e);
  }
  for (const [a, e] of fresh ?? []) add(a, e); // approvals newer than the cached list
  for (const a of cfg.allowedAccounts) out.set(a, { account: a, source: "env", approvedAt: null, approvedBy: null });
  for (const a of cfg.adminAccounts ?? []) out.set(a, { account: a, source: "admin", approvedAt: null, approvedBy: null });
  return { allowed: [...out.values()].sort((a, b) => a.account.localeCompare(b.account)), truncated };
}

/** Waitlist with effective status (approved = currently on the allowlist), newest first. */
export async function listWaitlist(kv: KVLike, cfg: GateConfig): Promise<{ entries: AdminWaitlistItem[]; allowed: AdminAllowedItem[]; truncated: boolean }> {
  const wl = await freshWaitlist(kv);
  const al = await listAllowed(kv, cfg, wl.allow);
  const allowed = new Map(al.allowed.map((a) => [a.account, a]));
  const entries: AdminWaitlistItem[] = wl.entries.map((e) => {
    const a = allowed.get(e.account);
    return {
      account: e.account,
      contact: e.contact ?? null,
      joinedAt: e.createdAt,
      status: a ? "approved" : e.status === "revoked" ? "revoked" : "pending",
      approvedAt: a?.approvedAt ?? null,
      approvedBy: a?.approvedBy ?? null,
    };
  });
  entries.sort((x, y) => y.joinedAt - x.joinedAt);
  return { entries, allowed: al.allowed, truncated: wl.truncated || al.truncated };
}

/** Writes `allow:<account>` and marks the waitlist entry (if any) approved. */
export async function approveAccounts(kv: KVLike, accounts: string[], by: string, now = Date.now()): Promise<AdminResult[]> {
  return Promise.all(
    accounts.map(async (raw) => {
      const account = norm(raw);
      const allow: AllowEntry = { approvedAt: now, approvedBy: by };
      await kv.put(allowKey(account), JSON.stringify(allow), { metadata: allow });
      const e = await getEntry(kv, account);
      if (e) await putEntry(kv, { ...e, status: "approved", approvedAt: now, approvedBy: by, updatedAt: now });
      return { account, ok: true, ...(e ? {} : { note: "approved (was not on the waitlist)" }) };
    }),
  );
}

function envNote(account: string, cfg: GateConfig): string | null {
  if (isAdmin(account, cfg)) return "is an admin (ADMIN_ACCOUNTS); remove it there and redeploy";
  if (cfg.allowedAccounts.includes(account)) return "is in the ALLOWED_ACCOUNTS var; remove it there and redeploy";
  return null;
}

/** Deletes `allow:<account>`; the waitlist entry stays (marked revoked). */
export async function revokeAccounts(kv: KVLike, accounts: string[], cfg: GateConfig, now = Date.now()): Promise<AdminResult[]> {
  return Promise.all(
    accounts.map(async (raw) => {
      const account = norm(raw);
      await kv.delete?.(allowKey(account));
      const e = await getEntry(kv, account);
      if (e) await putEntry(kv, { ...e, status: "revoked", revokedAt: now, updatedAt: now });
      const note = envNote(account, cfg);
      return { account, ok: !note, ...(note ? { note } : {}) };
    }),
  );
}

/** Revokes access and deletes the waitlist request entirely. */
export async function removeAccounts(kv: KVLike, accounts: string[], cfg: GateConfig): Promise<AdminResult[]> {
  return Promise.all(
    accounts.map(async (raw) => {
      const account = norm(raw);
      await Promise.all([kv.delete?.(allowKey(account)), kv.delete?.(waitlistKey(account))]);
      const note = envNote(account, cfg);
      return { account, ok: !note, ...(note ? { note: `request deleted, but ${account} ${note}` } : {}) };
    }),
  );
}

/** Rate-limit bucket for a client IP: IPv4 as-is, IPv6 by its /64 (one host usually owns a whole /64). */
export function ipBucket(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (!v.includes(":")) return v || "unknown";
  const [head, tail = ""] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = v.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = v.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
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
  const key = `wlrl:${ipBucket(ip)}:${window}`;
  const n = Number((await kv.get(key)) ?? 0) || 0;
  if (n >= limit) return false;
  await kv.put(key, String(n + 1), { expirationTtl: Math.max(60, windowS * 2) });
  return true;
}

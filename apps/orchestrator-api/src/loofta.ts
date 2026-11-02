/**
 * Loofta (loofta.com) "pay the creator" on token pages. Two routes (README "Loofta"):
 *
 *  - checkout (creator's own Loofta integrator key): POST {api}/payment-links with the page owner's key creates
 *    a one-off guest checkout (any token, any chain) that pays the creator's Loofta account. The key is stored
 *    exactly like bring-your-own AI keys: AES-256-GCM under KEY_ENCRYPTION_KEY, `account|loofta` as AAD, in KV
 *    `looftakey:<account>`, write-only (only the last 4 characters are ever returned), every call server-side.
 *  - send (no key): Loofta's Send page with the creator's payout target filled in (email, social handle or
 *    Loofta username). The target is encrypted too (`looftapay:<account>`, per-page overrides in `loofta:<ticker>`)
 *    and only handed out as a URL from POST /api/loofta/checkout, so it never appears in page config, the
 *    public launches list or the HTML. Visitors see a masked label only.
 *
 * Loofta has no sandbox (keys are live, real money), so off mainnet nothing is created and no payout URL is
 * returned: the widget is a preview.
 */
import { LOOFTA_SOCIAL_LABEL, type LooftaKeySummary, type LooftaPayTo, type LooftaPayToSummary, type LooftaPublic, type LooftaRoute } from "@osl/schema";
import { config } from "./config";
import { KeyError, aadFor, last4, openSecret, sealSecret } from "./llmkeys";
import type { KVLike } from "./sites";

export const LOOFTA_PROVIDER = "loofta";
const PAYTO_PROVIDER = "loofta-payto";
export const looftaKeyKey = (account: string) => `looftakey:${account}`;
export const looftaPayKey = (account: string) => `looftapay:${account}`;
export const looftaPageKey = (ticker: string) => `loofta:${ticker}`;
export const LOOFTA_KEY_RE = /^lft_[A-Za-z0-9_-]{8,256}$/;

type Sealed = { kv: number; iv: string; ct: string };
export interface LooftaKeyRecord extends Sealed {
  v: 1;
  createdAt: number;
  updatedAt: number;
  valid: boolean;
  validatedAt: number;
  /** Our own short message (never Loofta's response text). */
  lastError?: string | null;
}
/** A sealed payout target plus non-secret metadata for summaries without decrypting. */
export interface PayToRecord extends Sealed {
  v: 1;
  kind: LooftaPayTo["kind"];
  platform?: string;
  updatedAt: number;
}
export interface PageRecord {
  enabled: boolean;
  payTo?: PayToRecord;
}

const del = (kv: KVLike, key: string) => (kv.delete ? kv.delete(key) : kv.put(key, ""));
const parse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

// ---------------- the creator's Loofta key ----------------
export function cleanLooftaKey(raw: unknown): string {
  const k = typeof raw === "string" ? raw.trim() : "";
  if (!LOOFTA_KEY_RE.test(k)) throw new KeyError("that doesn't look like a Loofta API key (they start with lft_)", 400, "bad_key");
  return k;
}
export const readLooftaKey = async (kv: KVLike, account: string) => parse<LooftaKeyRecord>(await kv.get(looftaKeyKey(account)));
export const writeLooftaKey = (kv: KVLike, account: string, r: LooftaKeyRecord) => kv.put(looftaKeyKey(account), JSON.stringify(r));
export const deleteLooftaKey = (kv: KVLike, account: string) => del(kv, looftaKeyKey(account));
export async function sealLooftaKey(account: string, apiKey: string): Promise<Sealed> {
  return sealSecret(apiKey, aadFor(account, LOOFTA_PROVIDER));
}
export const openLooftaKey = (account: string, r: Sealed) => openSecret(r, aadFor(account, LOOFTA_PROVIDER));
export async function summarizeLooftaKey(account: string, r: LooftaKeyRecord): Promise<LooftaKeySummary> {
  const k = await openLooftaKey(account, r).catch(() => null);
  return {
    last4: k ? last4(k) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    valid: r.valid && k !== null,
    validatedAt: r.validatedAt,
    lastError: k === null ? "stored key can't be decrypted; replace it" : (r.lastError ?? null),
  };
}

// ---------------- payout targets ----------------
const payAad = (owner: string) => aadFor(owner, PAYTO_PROVIDER);
/** `owner` is the account (creator default) or `ticker:<t>` (page override): the AAD binds each to its slot. */
export async function sealPayTo(owner: string, p: LooftaPayTo, now = Date.now()): Promise<PayToRecord> {
  const s = await sealSecret(JSON.stringify(p), payAad(owner));
  return { v: 1, ...s, kind: p.kind, ...(p.kind === "social" ? { platform: p.platform } : {}), updatedAt: now };
}
export async function openPayTo(owner: string, r: PayToRecord): Promise<LooftaPayTo | null> {
  try {
    return JSON.parse(await openSecret(r, payAad(owner))) as LooftaPayTo;
  } catch {
    return null;
  }
}
export const pageOwnerId = (ticker: string) => `ticker:${ticker}`;
export const readPayTo = async (kv: KVLike, account: string) => parse<PayToRecord>(await kv.get(looftaPayKey(account)));
export const writePayTo = (kv: KVLike, account: string, r: PayToRecord) => kv.put(looftaPayKey(account), JSON.stringify(r));
export const deletePayTo = (kv: KVLike, account: string) => del(kv, looftaPayKey(account));
export const readPage = async (kv: KVLike, ticker: string) => parse<PageRecord>(await kv.get(looftaPageKey(ticker)));
export async function writePage(kv: KVLike, ticker: string, r: PageRecord) {
  if (!r.enabled && !r.payTo) return del(kv, looftaPageKey(ticker));
  return kv.put(looftaPageKey(ticker), JSON.stringify(r));
}

/** "j•••@gmail.com": keeps the first character and the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}
/** What visitors may see: an email is never shown in full; handles are public by nature. */
export function payToLabel(p: Pick<LooftaPayTo, "kind" | "value"> & { platform?: string }, forOwner = false): string {
  if (p.kind === "email") return forOwner ? maskEmail(p.value) : "the creator (by email)";
  if (p.kind === "social") return `@${p.value} on ${LOOFTA_SOCIAL_LABEL[p.platform as keyof typeof LOOFTA_SOCIAL_LABEL] ?? p.platform}`;
  return `@${p.value} on Loofta`;
}
export function summarizePayTo(p: LooftaPayTo): LooftaPayToSummary {
  return { kind: p.kind, ...(p.kind === "social" ? { platform: p.platform } : {}), display: payToLabel(p, true) };
}

/** Loofta's Send page with the target and amount filled in (from Loofta's own SendPage `to/method/platform/amount` and `/me` `payto`). */
export function sendUrl(p: LooftaPayTo, amountUsd: number, payBase = config.looftaPayBase): string {
  const q = new URLSearchParams({ tab: "send" });
  if (p.kind === "username") q.set("payto", p.value);
  else {
    q.set("to", p.value);
    q.set("method", p.kind);
    if (p.kind === "social") q.set("platform", p.platform);
  }
  q.set("amount", String(amountUsd));
  return `${payBase}/app?${q.toString()}`;
}

// ---------------- which route a page uses ----------------
export interface Resolved {
  route: LooftaRoute;
  label: string;
  /** checkout: the owner's decrypted Loofta key (server-side only). */
  apiKey?: string;
  /** send: the decrypted payout target (server-side only). */
  payTo?: LooftaPayTo;
}
/** Page override > owner's key > owner's default target. Null = no usable route (widget hidden). */
export async function resolveRoute(kv: KVLike, ticker: string, owner: string | null, page: PageRecord | null, withSecrets = false): Promise<Resolved | null> {
  if (page?.payTo) {
    const p = await openPayTo(pageOwnerId(ticker), page.payTo);
    if (p) return { route: "send", label: payToLabel(p), ...(withSecrets ? { payTo: p } : {}) };
  }
  if (!owner) return null;
  const k = await readLooftaKey(kv, owner);
  if (k?.valid) {
    const apiKey = await openLooftaKey(owner, k).catch(() => null);
    if (apiKey) return { route: "checkout", label: "the creator's Loofta account", ...(withSecrets ? { apiKey } : {}) };
  }
  const d = await readPayTo(kv, owner);
  const p = d ? await openPayTo(owner, d) : null;
  if (p) return { route: "send", label: payToLabel(p), ...(withSecrets ? { payTo: p } : {}) };
  return null;
}
export const toPublic = (r: Resolved): LooftaPublic => ({ enabled: true, route: r.route, label: r.label, preview: config.networkId !== "mainnet" });

// ---------------- Loofta HTTP (only ever to config.looftaApiBase, never following redirects) ----------------
const TIMEOUT_MS = 12_000;
async function looftaFetch(path: string, apiKey: string, init: RequestInit = {}): Promise<Response> {
  const base = new URL(config.looftaApiBase);
  if (base.protocol !== "https:") throw new KeyError("Loofta API base must be https", 503, "bad_config");
  const r = await globalThis.fetch(`${base.origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (r.status >= 300 && r.status < 400) throw new KeyError("Loofta answered with a redirect; refusing to follow it", 502, "provider_redirect");
  return r;
}
export type LooftaValidation = { ok: true } | { ok: false; status: number; error: string };
/** Loofta's JSON error `message` (NestJS: string or string[]), only ever used for matching, never shown. */
async function errorMessage(r: Response): Promise<string> {
  const j = (await r.json().catch(() => null)) as { message?: unknown } | null;
  const m = j?.message;
  return Array.isArray(m) ? m.map(String).join("; ") : typeof m === "string" ? m : "";
}
/** Loofta's 400 for a key whose Loofta account can't receive payments (checked live, 2026-11-02). */
export const NO_OWNER_RE = /no owner to receive payments/i;
/**
 * Harmless key check: look up a payment link that can't exist. Checked live (2026-11-02): a bad key gets
 * 401 "Invalid or revoked integrator API key", no key 401 "Missing integrator API key", and a valid key
 * 404 "Payment link not found". A route-level 404 ("Cannot GET /payment-links/…", NestJS) means the endpoint
 * moved and says nothing about the key, so it is not accepted. Note: this can't tell whether the key's
 * Loofta account can receive payments ("no owner"); only creating a link does (see createPaymentLink).
 */
export async function validateLooftaKey(apiKey: string): Promise<LooftaValidation> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
  let r: Response;
  try {
    r = await looftaFetch(`/payment-links/yeetcheck${id}`, apiKey);
  } catch (e) {
    return { ok: false, status: 502, error: e instanceof KeyError ? e.message : "couldn't reach Loofta to check the key; try again" };
  }
  if (r.status === 401) return { ok: false, status: 400, error: "Loofta rejected the key (invalid or revoked). Create a new one in Loofta → API key & branding." };
  if (r.status === 403) return { ok: false, status: 400, error: "Loofta says this key can't manage payment links (HTTP 403). Give it the payment_links scope." };
  if (r.status === 404) {
    if (/^Cannot [A-Z]+ \//.test(await errorMessage(r))) return { ok: false, status: 502, error: "Loofta's key-check endpoint isn't there any more (HTTP 404 route not found); try again later." };
    return { ok: true };
  }
  if (r.ok) return { ok: true };
  if (r.status === 429) return { ok: false, status: 429, error: "Loofta rate limit reached (HTTP 429); try again in a minute." };
  return { ok: false, status: 502, error: `Loofta returned HTTP ${r.status} while checking the key; try again later.` };
}
/** Mainnet only (caller checks): a one-off Loofta payment link paying the key owner. Returns only the checkout URL. */
export async function createPaymentLink(apiKey: string, amountUsd: number, message: string, returnUrl: string | null): Promise<string> {
  const r = await looftaFetch("/payment-links", apiKey, {
    method: "POST",
    body: JSON.stringify({ amount: amountUsd, message, is_private: false, ...(returnUrl ? { return_url: returnUrl } : {}) }),
  });
  if (r.status === 401 || r.status === 403) throw new KeyError("the creator's Loofta key was rejected; they need to replace it", 502, "provider_auth");
  if (r.status === 429) throw new KeyError("Loofta is busy right now (rate limit); try again in a minute", 429, "provider_rate");
  if (r.status === 400 && NO_OWNER_RE.test(await errorMessage(r)))
    throw new KeyError("the creator's Loofta key isn't linked to a Loofta account that can receive payments; they need to finish their Loofta account setup or replace the key", 409, "provider_no_owner");
  if (!r.ok) throw new KeyError(`Loofta couldn't create the payment (HTTP ${r.status})`, 502, "provider_error");
  // Live response (2026-11-02, HTTP 201): {short_id, url: "https://pay.loofta.xyz/checkout/<short_id>?callback=<return_url>", amount, message, webhook_secret: null}
  const j = (await r.json().catch(() => null)) as { url?: unknown } | null;
  const url = typeof j?.url === "string" ? j.url : "";
  if (!isCheckoutUrl(url)) throw new KeyError("Loofta returned an unexpected checkout link", 502, "provider_error");
  return url;
}
/**
 * Loofta's own checkout hosts. Live (2026-11-02) the API returns `https://pay.loofta.xyz/checkout/<short_id>?callback=…`
 * (308 to pay.loofta.com, then 307 to /checkout/<claim uuid>), while its docs show pay.loofta.com: accept both.
 */
export const LOOFTA_CHECKOUT_ORIGINS = ["https://pay.loofta.com", "https://pay.loofta.xyz"];
export function isCheckoutUrl(url: string, payBase = config.looftaPayBase): boolean {
  try {
    const u = new URL(url);
    const allowed = new Set([new URL(payBase).origin, ...LOOFTA_CHECKOUT_ORIGINS]);
    return u.protocol === "https:" && !u.username && !u.password && allowed.has(u.origin) && /^\/checkout\/[A-Za-z0-9_-]{4,64}\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Per-IP fixed window for the public checkout endpoint (KV `lftrl:`). */
export const CHECKOUT_RATE_LIMIT = 20;
export async function takeCheckoutRate(kv: KVLike, ip: string, now = Date.now(), limit = CHECKOUT_RATE_LIMIT): Promise<boolean> {
  const w = Math.floor(now / 600_000);
  const bucket = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip; // IPv6: per /64
  const key = `lftrl:${bucket}:${w}`;
  const n = Number((await kv.get(key)) ?? 0) || 0;
  if (n >= limit) return false;
  await kv.put(key, String(n + 1), { expirationTtl: 1200 });
  return true;
}
/** Visitor note: printable, single line, short. */
export const cleanMessage = (s: string | undefined, fallback: string) => {
  const m = (s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return m || fallback;
};

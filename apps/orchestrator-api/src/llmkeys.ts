/**
 * Bring-your-own LLM key.
 *
 *  - Providers are a fixed allowlist (no arbitrary base URLs: prevents SSRF and key exfiltration).
 *  - Keys are encrypted with AES-256-GCM (WebCrypto) under a master key from the KEY_ENCRYPTION_KEY Worker
 *    secret, with a random 12-byte IV per record and `account|provider` bound as AAD. Only ciphertext and
 *    non-secret metadata (provider, model, timestamps, validity) are stored, in KV `llmkey:<account>`
 *    (the platform default key is `llmkey:__platform__`). The last 4 characters are derived by decrypting.
 *  - Keys are write-only: nothing here returns a key, and provider error text is never passed through
 *    (it can echo part of the key), so keys can't leak into responses or logs.
 */
import { config } from "./config";
import type { KVLike } from "./sites";

export const PROVIDERS = {
  nearai: {
    label: "NEAR AI",
    baseUrl: "https://cloud-api.near.ai/v1",
    keysUrl: "https://cloud.near.ai",
    /** Cheap, low-token models first; the first one the provider lists is the default. */
    preferredModels: ["z-ai/glm-5.3-flash", "openai/gpt-4.1-nano", "google/gemini-2.5-flash-lite", "deepseek/deepseek-v4.1-flash"],
  },
  ollama: {
    label: "Ollama",
    baseUrl: "https://ollama.com/v1",
    keysUrl: "https://ollama.com/settings/keys",
    preferredModels: ["gemma4:31b", "nemotron-3-nano:30b", "gpt-oss:20b", "gpt-oss:120b"],
  },
} as const;
export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProviderId = (p: unknown): p is ProviderId => typeof p === "string" && Object.hasOwn(PROVIDERS, p);

/** Every URL a key is ever sent to is under one of these base URLs (https, exact origin + path prefix), or exact. */
const ALLOWED_BASES = Object.values(PROVIDERS).map((p) => `${p.baseUrl}/`);
const ALLOWED_EXACT = ["https://ollama.com/api/me"];

export function isAllowedUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const norm = `${u.origin}${u.pathname}`;
  return ALLOWED_EXACT.includes(norm) || ALLOWED_BASES.some((b) => norm.startsWith(b) && norm.length > b.length);
}

/** The provider for an exact allowlisted base URL (used to map the env fallback), else null. */
export function providerForBaseUrl(baseUrl: string): ProviderId | null {
  const b = baseUrl.replace(/\/+$/, "");
  return PROVIDER_IDS.find((id) => PROVIDERS[id].baseUrl === b) ?? null;
}

export const PLATFORM = "__platform__";
export const recordKey = (account: string) => `llmkey:${account}`;
export const KEY_MAX_LEN = 512;
export const KEY_MIN_LEN = 8;
export const MODEL_MAX_LEN = 128;
export const KEY_RATE_LIMIT = 10; // save/validate/test per account per hour
export const MODELS_RATE_LIMIT = 30; // model list fetches per account per hour

export class KeyError extends Error {
  constructor(message: string, public status: 400 | 402 | 404 | 424 | 429 | 502 | 503 = 400, public code?: string) {
    super(message);
  }
}

/** Strips all whitespace; rejects empty, too long or non-printable keys. Never echoes the key. */
export function cleanKey(raw: unknown): string {
  if (typeof raw !== "string") throw new KeyError("apiKey is required");
  if (raw.length > KEY_MAX_LEN * 4) throw new KeyError(`API key is too long (max ${KEY_MAX_LEN} characters)`);
  const k = raw.replace(/\s+/g, "");
  if (k.length < KEY_MIN_LEN) throw new KeyError("API key is too short");
  if (k.length > KEY_MAX_LEN) throw new KeyError(`API key is too long (max ${KEY_MAX_LEN} characters)`);
  if (!/^[\x21-\x7e]+$/.test(k)) throw new KeyError("API key has characters that aren't allowed");
  return k;
}

export function cleanModel(raw: unknown): string {
  if (typeof raw !== "string") throw new KeyError("model is required");
  const m = raw.trim();
  if (!m || m.length > MODEL_MAX_LEN || !/^[A-Za-z0-9._:/@~+-]+$/.test(m)) throw new KeyError("invalid model id");
  return m;
}

export const last4 = (k: string) => k.slice(-4);

// ---------------- crypto ----------------
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64e = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64d = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const aadFor = (account: string, provider: string): Uint8Array<ArrayBuffer> => new Uint8Array(enc.encode(`yeetpad-llmkey|v1|${account}|${provider}`));

const keyCache = new Map<string, Promise<CryptoKey>>();
/** Imports a base64 32-byte AES-256-GCM key (non-extractable). */
export function importMasterKey(b64: string): Promise<CryptoKey> {
  let p = keyCache.get(b64);
  if (!p) {
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = b64d(b64.trim());
    } catch {
      throw new KeyError("KEY_ENCRYPTION_KEY is not valid base64", 503, "key_storage_unconfigured");
    }
    if (raw.length !== 32) throw new KeyError("KEY_ENCRYPTION_KEY must be 32 bytes (base64)", 503, "key_storage_unconfigured");
    p = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    keyCache.set(b64, p);
  }
  return p;
}

export async function encryptSecret(master: CryptoKey, plaintext: string, aad: Uint8Array<ArrayBuffer>): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, master, enc.encode(plaintext)));
  return { iv: b64e(iv), ct: b64e(ct) };
}

/** Throws if the ciphertext, IV or AAD don't match (GCM auth tag). */
export async function decryptSecret(master: CryptoKey, box: { iv: string; ct: string }, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(box.iv), additionalData: aad, tagLength: 128 }, master, b64d(box.ct));
  return dec.decode(pt);
}

/** Master keys by version: KEY_ENCRYPTION_KEY is the current one (KEY_ENCRYPTION_KEY_VERSION, default 1);
 *  KEY_ENCRYPTION_KEY_PREV (+ _PREV_VERSION) can still decrypt older records during a rotation. */
function masterKeys(): { current: number; keys: Map<number, string> } {
  const keys = new Map<number, string>();
  const current = config.keyEncryptionKeyVersion;
  if (config.keyEncryptionKey) keys.set(current, config.keyEncryptionKey);
  if (config.keyEncryptionKeyPrev && config.keyEncryptionKeyPrevVersion !== current) keys.set(config.keyEncryptionKeyPrevVersion, config.keyEncryptionKeyPrev);
  return { current, keys };
}
export const keyStorageConfigured = () => !!config.keyEncryptionKey;

// ---------------- records ----------------
export interface KeyRecord {
  v: 1;
  /** Master key version used for `ct`. */
  kv: number;
  provider: ProviderId;
  model: string;
  iv: string;
  ct: string;
  createdAt: number;
  updatedAt: number;
  valid: boolean;
  validatedAt: number;
  /** Our own short message (never provider text). */
  lastError?: string | null;
  by?: string;
}

/** What the API returns about a key. Never contains the key. */
export interface KeySummary {
  provider: ProviderId;
  providerLabel: string;
  model: string;
  last4: string | null;
  createdAt: number;
  updatedAt: number;
  valid: boolean;
  validatedAt: number;
  lastError: string | null;
}

export async function readRecord(kv: KVLike, account: string): Promise<KeyRecord | null> {
  const raw = await kv.get(recordKey(account));
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as KeyRecord;
    return isProviderId(r.provider) && r.ct && r.iv ? r : null;
  } catch {
    return null;
  }
}

/** Encrypts any secret under the current master key with the given AAD (shared by AI keys and Loofta). */
export async function sealSecret(plaintext: string, aad: Uint8Array<ArrayBuffer>): Promise<{ kv: number; iv: string; ct: string }> {
  const { current, keys } = masterKeys();
  const b = keys.get(current);
  if (!b) throw new KeyError("key storage isn't configured on this server (KEY_ENCRYPTION_KEY)", 503, "key_storage_unconfigured");
  return { kv: current, ...(await encryptSecret(await importMasterKey(b), plaintext, aad)) };
}

/** Decrypts a sealed secret (server-side use only). */
export async function openSecret(box: { kv: number; iv: string; ct: string }, aad: Uint8Array<ArrayBuffer>): Promise<string> {
  const b = masterKeys().keys.get(box.kv);
  if (!b) throw new KeyError("the stored key was encrypted with a master key this server doesn't have; replace the key", 503, "key_undecryptable");
  try {
    return await decryptSecret(await importMasterKey(b), box, aad);
  } catch (e) {
    if (e instanceof KeyError) throw e;
    throw new KeyError("the stored key couldn't be decrypted; replace the key", 503, "key_undecryptable");
  }
}

export const sealKey = (account: string, provider: ProviderId, apiKey: string) => sealSecret(apiKey, aadFor(account, provider));

/** Decrypts a record's key (server-side use only). */
export const openKey = (account: string, r: KeyRecord): Promise<string> => openSecret(r, aadFor(account, r.provider));

export async function summarize(account: string, r: KeyRecord): Promise<KeySummary> {
  const k = await openKey(account, r).catch(() => null);
  return {
    provider: r.provider,
    providerLabel: PROVIDERS[r.provider].label,
    model: r.model,
    last4: k ? last4(k) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    valid: r.valid && k !== null,
    validatedAt: r.validatedAt,
    lastError: k === null ? "stored key can't be decrypted; replace it" : (r.lastError ?? null),
  };
}

export async function writeRecord(kv: KVLike, account: string, r: KeyRecord) {
  await kv.put(recordKey(account), JSON.stringify(r));
}

export async function deleteRecord(kv: KVLike, account: string) {
  await kv.delete?.(recordKey(account));
}

/** Per-account fixed-window limiter (KV counter, ~1 h). */
export async function takeKeyRate(kv: KVLike, account: string, bucket: "save" | "models" | "loofta", limit: number, now = Date.now()): Promise<boolean> {
  const w = Math.floor(now / 3_600_000);
  const k = `llmrl:${bucket}:${account}:${w}`;
  const n = Number((await kv.get(k)) ?? 0) || 0;
  if (n >= limit) return false;
  await kv.put(k, String(n + 1), { expirationTtl: 7200 });
  return true;
}

// ---------------- provider calls ----------------
/**
 * fetch that only talks to allowlisted provider URLs over https and never follows redirects
 * (a redirect could carry the Authorization header to another host). Used for every call that carries a key.
 */
export const guardedFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!isAllowedUrl(url)) throw new KeyError("provider URL is not on the allowlist", 400, "url_not_allowed");
  const r = await globalThis.fetch(input as RequestInfo, { ...init, redirect: "manual" });
  if (r.status >= 300 && r.status < 400) throw new KeyError("provider answered with a redirect; refusing to follow it", 502, "provider_redirect");
  return r;
}) as typeof fetch;

const TIMEOUT_MS = 15_000;
const authHeaders = (apiKey: string) => ({ authorization: `Bearer ${apiKey}`, accept: "application/json" });

/** A short, key-free message for a provider HTTP status. */
export function statusMessage(provider: ProviderId, status: number): string {
  const p = PROVIDERS[provider].label;
  if (status === 401 || status === 403) return `${p} rejected the key (HTTP ${status}). Check it, or replace it in AI key settings.`;
  if (status === 402) return `${p} says the key has no credit left (HTTP 402). Top up with ${p}, or use the platform key.`;
  if (status === 429) return `${p} rate limit or quota reached (HTTP 429). Try again later, or use the platform key.`;
  if (status === 404) return `${p} doesn't know that model (HTTP 404). Pick another model.`;
  if (status === 400 || status === 422) return `${p} rejected the request (HTTP ${status}); the model may not be available for this key.`;
  return `${p} returned HTTP ${status}.`;
}

export interface ModelInfo {
  id: string;
  /** Completion price per token (USD) when the provider publishes it. */
  price?: number;
}

/** GET <base>/models with the key; text models only, cheapest/known-cheap first. */
export async function listModels(provider: ProviderId, apiKey: string): Promise<ModelInfo[]> {
  const r = await guardedFetch(`${PROVIDERS[provider].baseUrl}/models`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e) => {
    throw e instanceof KeyError ? e : new KeyError(`${PROVIDERS[provider].label} couldn't be reached`, 502, "provider_unreachable");
  });
  if (!r.ok) throw new KeyError(statusMessage(provider, r.status), r.status === 401 || r.status === 403 ? 400 : 502, "provider_error");
  const j = (await r.json().catch(() => null)) as { data?: Record<string, unknown>[] } | null;
  const rows = Array.isArray(j?.data) ? j!.data : [];
  const out: ModelInfo[] = [];
  for (const m of rows) {
    const id = typeof m.id === "string" ? m.id : null;
    if (!id || id.length > MODEL_MAX_LEN) continue;
    const outMods = (m.output_modalities ?? (m.architecture as { outputModalities?: unknown } | undefined)?.outputModalities) as unknown;
    if (Array.isArray(outMods) && !outMods.includes("text")) continue;
    const price = Number((m.pricing as { completion?: unknown } | undefined)?.completion);
    out.push(Number.isFinite(price) && price >= 0 ? { id, price } : { id });
  }
  const pref = PROVIDERS[provider].preferredModels as readonly string[];
  const rank = (m: ModelInfo) => (pref.includes(m.id) ? pref.indexOf(m.id) : pref.length);
  return out.sort((a, b) => rank(a) - rank(b) || (a.price ?? 1) - (b.price ?? 1) || a.id.localeCompare(b.id)).slice(0, 500);
}

export function defaultModel(provider: ProviderId, models: ModelInfo[]): string | null {
  for (const p of PROVIDERS[provider].preferredModels) if (models.some((m) => m.id === p)) return p;
  return models[0]?.id ?? null;
}

export type Validation = { ok: true } | { ok: false; status: number; error: string };

/**
 * Cheap authenticated check. /models is public on both providers, so it can't tell a good key from a bad one:
 *  - Ollama: POST https://ollama.com/api/me (account lookup, no inference).
 *  - NEAR AI: a 1-token chat completion on the chosen model (a bad key fails before any inference).
 */
export async function validateKey(provider: ProviderId, apiKey: string, model: string): Promise<Validation> {
  try {
    const r =
      provider === "ollama"
        ? await guardedFetch("https://ollama.com/api/me", { method: "POST", headers: authHeaders(apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) })
        : await guardedFetch(`${PROVIDERS[provider].baseUrl}/chat/completions`, {
            method: "POST",
            headers: { ...authHeaders(apiKey), "content-type": "application/json" },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with: ok" }], max_tokens: 1 }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
    await r.body?.cancel().catch(() => {});
    return r.ok ? { ok: true } : { ok: false, status: r.status, error: statusMessage(provider, r.status) };
  } catch (e) {
    return { ok: false, status: 502, error: e instanceof KeyError ? e.message : `${PROVIDERS[provider].label} couldn't be reached` };
  }
}

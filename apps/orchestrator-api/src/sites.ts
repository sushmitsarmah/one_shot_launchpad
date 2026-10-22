/**
 * Token site configs. Stored in Cloudflare KV (binding SITES, key `site:<ticker>`) when running as a
 * Worker; an in-memory map for the local Bun server and tests. A compact copy also lives on-chain
 * in the factory registry (`site` field), used if KV has no entry.
 */
import { IntentsConfig, SiteConfig, slugify, type LaunchIdea } from "@osl/schema";
import { config } from "./config";

export interface KVListResult {
  keys: { name: string; metadata?: unknown }[];
  list_complete: boolean;
  cursor?: string;
}
export interface KVLike {
  get(key: string, opts?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete?(key: string): Promise<void>;
  list?(opts: { prefix?: string; cursor?: string; limit?: number }): Promise<KVListResult>;
}

/**
 * Reads many keys. Uses Workers KV bulk get (≤100 keys per call, one KV operation each) when the
 * binding supports it, else one get per key. Unlike list(), these reads see recent writes.
 */
export async function getMany(kv: KVLike, keys: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    let bulk: unknown = null;
    if (!(kv instanceof MemoryKV)) {
      try {
        bulk = await (kv.get as unknown as (k: string[]) => Promise<unknown>)(chunk);
      } catch {
        bulk = null;
      }
    }
    if (bulk instanceof Map) for (const k of chunk) out.set(k, (bulk.get(k) as string | null | undefined) ?? null);
    else await Promise.all(chunk.map(async (k) => out.set(k, await kv.get(k))));
  }
  return out;
}

export class MemoryKV implements KVLike {
  private m = new Map<string, string>();
  private meta = new Map<string, unknown>();
  private exp = new Map<string, number>();
  async get(k: string) {
    const e = this.exp.get(k);
    if (e !== undefined && e <= Date.now()) {
      this.m.delete(k);
      this.exp.delete(k);
    }
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string, opts?: { expirationTtl?: number; metadata?: unknown }) {
    this.m.set(k, v);
    if (opts?.metadata !== undefined) this.meta.set(k, opts.metadata);
    else this.meta.delete(k);
    if (opts?.expirationTtl) this.exp.set(k, Date.now() + opts.expirationTtl * 1000);
    else this.exp.delete(k);
  }
  async delete(k: string) {
    this.m.delete(k);
    this.meta.delete(k);
    this.exp.delete(k);
  }
  /** Same shape as Workers KV list(): sorted names, `limit` per page (default 1000), opaque cursor. */
  async list(opts: { prefix?: string; cursor?: string; limit?: number }) {
    const now = Date.now();
    const names = [...this.m.keys()]
      .filter((k) => k.startsWith(opts.prefix ?? "") && !((this.exp.get(k) ?? Infinity) <= now))
      .sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? 1000;
    const page = names.slice(start, start + limit);
    const done = start + limit >= names.length;
    return {
      keys: page.map((name) => ({ name, ...(this.meta.has(name) ? { metadata: this.meta.get(name) } : {}) })),
      list_complete: done,
      ...(done ? {} : { cursor: String(start + limit) }),
    };
  }
}

let store: KVLike = new MemoryKV();
let usingKv = false;
export function setSiteStore(kv: KVLike | undefined) {
  if (kv) {
    store = kv;
    usingKv = true;
  }
}
export const siteStoreKind = () => (usingKv ? "kv" : "memory");
/** The shared KV store (also used for waitlist entries and rate-limit counters). */
export const kvStore = (): KVLike => store;

const key = (ticker: string) => `site:${ticker}`;
const slugKey = (slug: string) => `slug:${slug}`;

/**
 * Picks a free slug for `ticker` from `name`: the slugified name, then -2, -3, ... when the slug is
 * already mapped to a different ticker. Falls back to the ticker if the name has no usable chars.
 */
export async function claimSlug(name: string, ticker: string, kv: KVLike = store): Promise<string> {
  const base = slugify(name) || ticker;
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const cand = `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
    const owner = await kv.get(slugKey(cand));
    if (!owner || owner === ticker) return cand;
  }
  return ticker;
}

/** Writes `site:<ticker>` (full config) and `slug:<slug>` -> ticker. Assigns a slug if missing. */
export async function putSite(site: SiteConfig): Promise<SiteConfig> {
  const ticker = site.branding.ticker.toLowerCase();
  const slug = site.slug ?? (await claimSlug(site.branding.name, ticker));
  const full = { ...site, slug };
  await store.put(slugKey(slug), ticker);
  await store.put(key(ticker), JSON.stringify(full));
  return full;
}

/** Looks up a site by ticker or slug. */
export async function getSite(id: string): Promise<SiteConfig | null> {
  return (await findSite(id))?.site ?? null;
}

/** Like getSite, also returning the ticker the config is stored under. */
export async function findSite(id: string): Promise<{ site: SiteConfig; ticker: string } | null> {
  let ticker = id;
  let raw = await store.get(key(id));
  if (!raw) {
    const t = await store.get(slugKey(id));
    if (t) {
      ticker = t;
      raw = await store.get(key(t));
    }
  }
  if (!raw) return null;
  const parsed = SiteConfig.safeParse(JSON.parse(raw));
  return parsed.success ? { site: parsed.data, ticker } : null;
}

/** Overwrites the stored config for `ticker` (slug index untouched). */
export async function saveSite(ticker: string, site: SiteConfig) {
  await store.put(key(ticker), JSON.stringify(site));
}

/**
 * Page views counted by the frontend Worker (`views:<ticker>`). KV is eventually consistent and the
 * counter is a read-modify-write, so concurrent views can be lost: treat it as approximate.
 */
export async function getViews(ticker: string): Promise<number> {
  const n = Number(await store.get(`views:${ticker}`));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Public site URL; pass the slug when known, else the ticker. */
export const siteUrl = (id: string) => `${config.siteBase.replace(/\/$/, "")}/t/${id}`;

export function buildSiteConfig(
  owner: string,
  idea: LaunchIdea,
  tokenId: string,
  extra: { txHash?: string; icon?: string } = {},
): SiteConfig {
  return SiteConfig.parse({
    siteId: `${idea.ticker}-${Date.now().toString(36)}`,
    ownerWallet: owner,
    ecosystem: "near",
    blueprint: "meme-landing",
    theme: { colors: idea.colors, fonts: { heading: "Bowlby One", body: "Space Grotesk" } },
    branding: { name: idea.name, ticker: idea.ticker.toUpperCase(), tagline: idea.tagline, description: idea.description },
    tokenLaunch: {
      contractOrMintAddress: tokenId,
      buyUrl: `${config.explorerBase}/token/${tokenId}`,
      explorerUrl: `${config.explorerBase}/address/${tokenId}`,
      txHash: extra.txHash,
      launchedAt: Date.now(),
    },
    iconDataUri: extra.icon,
  });
}

/** Compact JSON stored on-chain with the factory record (<= 2 KiB). */
export function compactSite(idea: LaunchIdea): string {
  const s = JSON.stringify({ v: 1, tagline: idea.tagline, description: idea.description, colors: idea.colors });
  return s.length <= 2048 ? s : JSON.stringify({ v: 1, tagline: idea.tagline, colors: idea.colors });
}

// ---------- soft delete ("take down") ----------
export interface Takedown {
  at: number;
  by: string;
  byAdmin?: boolean;
}
const delKey = (ticker: string) => `deleted:${ticker}`;

/** The takedown record for `ticker`, or null. `deleted:<ticker>` is the source of truth (works for chain-only tokens too). */
export async function getTakedown(ticker: string, kv: KVLike = store): Promise<Takedown | null> {
  const raw = await kv.get(delKey(ticker));
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Takedown | null;
    return t && typeof t.at === "number" ? t : null;
  } catch {
    return null;
  }
}

/** Marks a token's site taken down (keeps all data; mirrored into the site record for the page Worker). */
export async function takeDown(ticker: string, t: Takedown, kv: KVLike = store) {
  await kv.put(delKey(ticker), JSON.stringify(t));
  const found = await findSite(ticker);
  if (found) await saveSite(found.ticker, { ...found.site, takenDown: t });
}

export async function restoreTakedown(ticker: string, kv: KVLike = store) {
  if (kv.delete) await kv.delete(delKey(ticker));
  else await kv.put(delKey(ticker), "null");
  const found = await findSite(ticker);
  if (found?.site.takenDown) {
    const { takenDown: _t, ...site } = found.site;
    await saveSite(found.ticker, site);
  }
}

// ---------- NEAR Intents widget settings (intents:<ticker>; works for KV and chain-only token pages) ----------
const intentsKey = (ticker: string) => `intents:${ticker}`;
export async function getIntents(ticker: string, kv: KVLike = store): Promise<IntentsConfig | null> {
  const raw = await kv.get(intentsKey(ticker));
  if (!raw) return null;
  const p = IntentsConfig.safeParse(JSON.parse(raw));
  return p.success ? p.data : null;
}
export async function setIntents(ticker: string, cfg: IntentsConfig, kv: KVLike = store) {
  await kv.put(intentsKey(ticker), JSON.stringify(cfg));
}

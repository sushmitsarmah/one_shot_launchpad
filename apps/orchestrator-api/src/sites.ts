/**
 * Token site configs. Stored in Cloudflare KV (binding SITES, key `site:<ticker>`) when running as a
 * Worker; an in-memory map for the local Bun server and tests. A compact copy also lives on-chain
 * in the factory registry (`site` field), used if KV has no entry.
 */
import { SiteConfig, slugify, type LaunchIdea } from "@osl/schema";
import { config } from "./config";

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

class MemoryKV implements KVLike {
  private m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
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
  let raw = await store.get(key(id));
  if (!raw) {
    const ticker = await store.get(slugKey(id));
    if (ticker) raw = await store.get(key(ticker));
  }
  if (!raw) return null;
  const parsed = SiteConfig.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
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

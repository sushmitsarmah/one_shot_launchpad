/**
 * Token site configs. Stored in Cloudflare KV (binding SITES, key `site:<ticker>`) when running as a
 * Worker; an in-memory map for the local Bun server and tests. A compact copy also lives on-chain
 * in the factory registry (`site` field), used if KV has no entry.
 */
import { SiteConfig, type LaunchIdea } from "@osl/schema";
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

export async function putSite(site: SiteConfig) {
  await store.put(key(site.branding.ticker.toLowerCase()), JSON.stringify(site));
}

export async function getSite(ticker: string): Promise<SiteConfig | null> {
  const raw = await store.get(key(ticker));
  if (!raw) return null;
  const parsed = SiteConfig.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export const siteUrl = (ticker: string) => `${config.siteBase.replace(/\/$/, "")}/t/${ticker}`;

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

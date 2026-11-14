/**
 * Daily caps on idea generation with the PLATFORM AI key (the admin's key / NEARAI_API_KEY), so an open
 * (LOCKED=0) testnet deployment can't be used to drain it with free faucet NEAR. Two fixed UTC-day windows:
 *   - per account: PLATFORM_IDEAS_PER_ACCOUNT_DAY ideas (default 150: one 100-token batch plus regenerations)
 *   - per client IP (IPv6 per /64): PLATFORM_IDEAS_PER_IP_DAY ideas (default 400, so many fresh wallets from one
 *     machine can't multiply the account cap)
 * 0 disables a cap. Admins and Autopilot agents are exempt (agents have their own server-enforced spend cap).
 * Requests that use the caller's own AI key never touch these counters. KV counters are soft (not atomic).
 */
import { ipBucket } from "./gate";
import type { KVLike } from "./sites";

export interface IdeaQuotaConfig {
  platformIdeasPerAccountDay: number;
  platformIdeasPerIpDay: number;
}

const day = (now: number) => Math.floor(now / 86_400_000);
export const quotaKeys = (account: string, ip: string, now = Date.now()) => ({
  account: `aiq:a:${account.toLowerCase()}:${day(now)}`,
  ip: `aiq:i:${ipBucket(ip)}:${day(now)}`,
});

export type QuotaResult = { ok: true } | { ok: false; scope: "account" | "ip"; limit: number; used: number };

/** Checks both windows for `count` more ideas and, only if both have room, counts them. */
export async function takeIdeaQuota(kv: KVLike, account: string, ip: string, count: number, cfg: IdeaQuotaConfig, now = Date.now()): Promise<QuotaResult> {
  const k = quotaKeys(account, ip, now);
  const [a, i] = await Promise.all([kv.get(k.account), kv.get(k.ip)]);
  const usedA = Number(a ?? 0) || 0;
  const usedI = Number(i ?? 0) || 0;
  const capA = cfg.platformIdeasPerAccountDay;
  const capI = cfg.platformIdeasPerIpDay;
  if (capA > 0 && usedA + count > capA) return { ok: false, scope: "account", limit: capA, used: usedA };
  if (capI > 0 && usedI + count > capI) return { ok: false, scope: "ip", limit: capI, used: usedI };
  const ttl = { expirationTtl: 2 * 86_400 };
  await Promise.all([kv.put(k.account, String(usedA + count), ttl), kv.put(k.ip, String(usedI + count), ttl)]);
  return { ok: true };
}

export function quotaMessage(r: Exclude<QuotaResult, { ok: true }>): string {
  const who = r.scope === "account" ? "this account" : "this network";
  return `Daily limit for the shared platform AI key reached: ${who} has generated ${r.used} of ${r.limit} ideas today (UTC). Add your own Ollama or NEAR AI key in AI key settings to keep going, or try again tomorrow. Nothing was charged.`;
}

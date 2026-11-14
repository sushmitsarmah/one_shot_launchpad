/**
 * Yeetpad Autopilot: an AI agent with its own NEAR account that generates, launches and lists tokens on rules a
 * human sets. See README "Autopilot agent".
 *
 * Trust model:
 *  - The agent signs in with a FunctionCall key limited to the vault (it has no full-access key at all), and only
 *    accounts admins listed (AGENT_ACCOUNTS env ∪ KV `agent:<account>`) may do that (auth.ts agentKeyAllowed).
 *  - Kill switch: KV `agentkill:<account>`, toggled by admins only. Enforced here on every gated endpoint.
 *  - Daily cap: min(the agent's published rules, AGENT_MAX_DAILY_NEAR), enforced here against a server-side
 *    spend counter (`agentspend:<account>:<UTC day>`), not just by the agent script.
 *  - Public ledger: KV `agentlog:<account>`, writable only by the agent's own session, readable by anyone.
 */
import { z } from "zod";
import { AuthError } from "./auth";
import type { KVLike } from "./sites";

const norm = (a: string) => a.trim().toLowerCase();
export const NEAR = 10n ** 24n;
export const nearToYocto = (n: number) => (BigInt(Math.round(n * 1e6)) * NEAR) / 1_000_000n;

export interface AgentGateConfig {
  agentAccounts: string[];
  agentMaxDailyNear: number;
}

// ---------- registry ----------
export const agentKey = (a: string) => `agent:${norm(a)}`;
export async function isAgentAccount(account: string, cfg: AgentGateConfig, kv: KVLike): Promise<boolean> {
  if (cfg.agentAccounts.includes(norm(account))) return true;
  return (await kv.get(agentKey(account), { cacheTtl: 30 }).catch(() => null)) !== null;
}
export async function setAgent(kv: KVLike, account: string, enabled: boolean, by: string) {
  if (enabled) await kv.put(agentKey(account), JSON.stringify({ at: Date.now(), by }));
  else await kv.delete?.(agentKey(account));
}
export async function listAgents(kv: KVLike, cfg: AgentGateConfig): Promise<string[]> {
  const kvAgents = kv.list ? (await kv.list({ prefix: "agent:" })).keys.map((k) => k.name.slice("agent:".length)) : [];
  return [...new Set([...cfg.agentAccounts, ...kvAgents])].sort();
}

// ---------- kill switch ----------
export interface KillState {
  paused: boolean;
  by: string | null;
  at: number | null;
  reason: string | null;
}
const killKey = (a: string) => `agentkill:${norm(a)}`;
export async function getKill(kv: KVLike, account: string): Promise<KillState> {
  const raw = await kv.get(killKey(account)).catch(() => null);
  if (!raw) return { paused: false, by: null, at: null, reason: null };
  try {
    return { paused: false, by: null, at: null, reason: null, ...(JSON.parse(raw) as Partial<KillState>) };
  } catch {
    return { paused: true, by: null, at: null, reason: "unreadable kill switch record (fail closed)" };
  }
}
export async function setKill(kv: KVLike, account: string, paused: boolean, by: string, reason: string | null = null): Promise<KillState> {
  const s: KillState = { paused, by, at: Date.now(), reason };
  await kv.put(killKey(account), JSON.stringify(s));
  return s;
}

// ---------- rules (agent.config.json, published by the agent so the ledger page shows them) ----------
export const AgentRules = z.object({
  name: z.string().max(60).optional(),
  launchesPerRun: z.number().int().min(1).max(20),
  maxCreditsPerDayNear: z.number().min(0).max(100),
  theme: z.string().min(3).max(400),
  listOn: z.enum(["none", "rhea"]),
  rhea: z.object({ openingFdvNear: z.number().positive().max(1e9).optional() }).optional(),
  schedule: z.string().max(80).optional(),
});
export type AgentRules = z.infer<typeof AgentRules>;
const rulesKey = (a: string) => `agentcfg:${norm(a)}`;
export async function getRules(kv: KVLike, account: string): Promise<AgentRules | null> {
  const raw = await kv.get(rulesKey(account)).catch(() => null);
  if (!raw) return null;
  const r = AgentRules.safeParse(JSON.parse(raw));
  return r.success ? r.data : null;
}
export const putRules = (kv: KVLike, account: string, rules: AgentRules) => kv.put(rulesKey(account), JSON.stringify(rules));

// ---------- daily spend ----------
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const spendKey = (a: string, day: string) => `agentspend:${norm(a)}:${day}`;
export async function spentToday(kv: KVLike, account: string, now = Date.now()): Promise<bigint> {
  const raw = await kv.get(spendKey(account, utcDay(now))).catch(() => null);
  try {
    return raw ? BigInt(raw) : 0n;
  } catch {
    return 0n;
  }
}
export async function addSpend(kv: KVLike, account: string, yocto: bigint, now = Date.now()) {
  if (yocto <= 0n) return;
  const cur = await spentToday(kv, account, now);
  await kv.put(spendKey(account, utcDay(now)), (cur + yocto).toString(), { expirationTtl: 3 * 86400 });
}
/** Effective daily cap: the stricter of the agent's own rules and the server ceiling. */
export async function dailyCap(kv: KVLike, account: string, cfg: AgentGateConfig): Promise<bigint> {
  const rules = await getRules(kv, account);
  const own = rules ? rules.maxCreditsPerDayNear : cfg.agentMaxDailyNear;
  return nearToYocto(Math.min(own, cfg.agentMaxDailyNear));
}

/** Throws unless the agent is running (kill switch off). No-op for non-agents. */
export async function assertAgentRunning(account: string, cfg: AgentGateConfig, kv: KVLike) {
  if (!(await isAgentAccount(account, cfg, kv))) return;
  const k = await getKill(kv, account);
  if (k.paused) throw new AuthError(`agent ${account} is paused by its kill switch${k.reason ? `: ${k.reason}` : ""}`, 423, "agent_paused");
}

/** Throws if spending `cost` more would take the agent over today's cap. No-op for non-agents. */
export async function assertAgentBudget(account: string, cost: bigint, cfg: AgentGateConfig, kv: KVLike) {
  if (!(await isAgentAccount(account, cfg, kv))) return;
  await assertAgentRunning(account, cfg, kv);
  const [spent, cap] = await Promise.all([spentToday(kv, account), dailyCap(kv, account, cfg)]);
  if (spent + cost > cap) {
    const f = (y: bigint) => (Number(y) / 1e24).toFixed(4);
    throw new AuthError(`agent daily cap reached: spent ${f(spent)} of ${f(cap)} NEAR today, this needs ${f(cost)}`, 429, "agent_cap");
  }
}

// ---------- public ledger ----------
const TxHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
export const LedgerEntry = z.object({
  runId: z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/),
  startedAt: z.number().int().positive(),
  finishedAt: z.number().int().positive(),
  status: z.enum(["ok", "partial", "failed", "stopped"]),
  reason: z.string().max(300).nullable().optional(),
  prompt: z.string().max(400),
  listOn: z.enum(["none", "rhea"]),
  ideas: z.array(z.object({ ticker: z.string().max(20), name: z.string().max(60) })).max(40),
  dropped: z.array(z.object({ ticker: z.string().max(20), why: z.string().max(80) })).max(40).optional(),
  tokens: z
    .array(
      z.object({
        ticker: z.string().max(20),
        name: z.string().max(60).optional(),
        ok: z.boolean(),
        tokenId: z.string().max(100).nullable(),
        slug: z.string().max(64).nullable(),
        error: z.string().max(200).nullable().optional(),
        listing: z.object({ ok: z.boolean(), url: z.string().url().max(200).nullable(), txHash: TxHash.nullable() }).nullable().optional(),
      }),
    )
    .max(40),
  creditsSpentYocto: z.string().regex(/^\d{1,40}$/),
  txHashes: z.array(TxHash).max(80),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;
export const LEDGER_MAX = 200;
const ledgerKey = (a: string) => `agentlog:${norm(a)}`;
export async function readLedger(kv: KVLike, account: string): Promise<LedgerEntry[]> {
  const raw = await kv.get(ledgerKey(account)).catch(() => null);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? (a as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}
export async function appendLedger(kv: KVLike, account: string, e: LedgerEntry): Promise<number> {
  const cur = (await readLedger(kv, account)).filter((x) => x.runId !== e.runId);
  const next = [e, ...cur].slice(0, LEDGER_MAX);
  await kv.put(ledgerKey(account), JSON.stringify(next));
  return next.length;
}

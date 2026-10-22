import OpenAI from "openai";
import { LaunchIdea, MAX_BATCH, launchIdeaJsonSchema } from "@osl/schema";
import { config, configVersion } from "./config";
import { PROVIDERS, guardedFetch, isAllowedUrl, providerForBaseUrl, statusMessage, type ProviderId } from "./llmkeys";

const SYSTEM = `You are a creative crypto launch strategist for the NEAR ecosystem.
Given a user's prompt, invent ONE token + landing-site idea. Reply with JSON only, matching:
{"name": string (2-40 chars), "ticker": string (2-16 chars, lowercase a-z/0-9, starts with a letter),
 "tagline": string (<=120 chars), "description": string (10-600 chars),
 "colors": {"primary","secondary","accent","background","text"} as #RRGGBB hex}.
Keep it fun but tasteful. Ensure text colour contrasts with background.`;

/** Where an LLM call goes. `env` = NEARAI_* vars; `platform` = admin-set stored key; `user` = the caller's own key. */
export interface LLMTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  source: "env" | "platform" | "user";
  provider?: ProviderId | null;
}

/** The env fallback (NEARAI_BASE_URL / NEARAI_MODEL / NEARAI_API_KEY). */
export function envTarget(): LLMTarget {
  if (!config.nearAiApiKey) throw new Error("NEARAI_API_KEY is not set (or set LLM_MOCK=1)");
  return { baseUrl: config.nearAiBaseUrl, apiKey: config.nearAiApiKey, model: config.nearAiModel, source: "env", provider: providerForBaseUrl(config.nearAiBaseUrl) };
}

/** An LLM call failed. The message is ours (provider text is dropped: it can echo part of the key). */
export class LLMCallError extends Error {
  constructor(message: string, public status: number | null, public source: LLMTarget["source"]) {
    super(message);
  }
}

let envClient: OpenAI | null = null;
let envClientVersion = -1;
function clientFor(t: LLMTarget): OpenAI {
  if (t.source === "env") {
    if (!envClient || envClientVersion !== configVersion()) {
      envClient = new OpenAI({ baseURL: t.baseUrl, apiKey: t.apiKey });
      envClientVersion = configVersion();
    }
    return envClient;
  }
  // Stored keys only ever go to allowlisted https URLs, without following redirects.
  if (!isAllowedUrl(`${t.baseUrl}/chat/completions`)) throw new LLMCallError("AI provider is not on the allowlist", null, t.source);
  return new OpenAI({ baseURL: t.baseUrl, apiKey: t.apiKey, fetch: guardedFetch, maxRetries: t.source === "user" ? 0 : 2 });
}

const redact = (msg: string, key: string) => (key && key.length >= 4 ? msg.split(key).join("[redacted]") : msg);

function sanitize(e: unknown, t: LLMTarget): Error {
  if (e instanceof LLMCallError) return e;
  if (e instanceof OpenAI.APIError && typeof e.status === "number") {
    const msg = t.provider ? statusMessage(t.provider, e.status) : `AI provider returned HTTP ${e.status}`;
    return new LLMCallError(msg, e.status, t.source);
  }
  if (e instanceof OpenAI.APIError || (e instanceof Error && /connection|fetch|network|timed? ?out/i.test(e.name + e.message))) {
    return new LLMCallError(`${t.provider ? PROVIDERS[t.provider].label : "AI provider"} couldn't be reached`, null, t.source);
  }
  if (e instanceof Error) return new Error(redact(e.message, t.apiKey));
  return new Error("LLM call failed");
}

/** Best-effort cleanup of common LLM slips before strict validation. */
export function normalizeIdea(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (typeof o.ticker === "string") {
    let t = o.ticker.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!/^[a-z]/.test(t)) t = `t${t}`;
    o.ticker = t.slice(0, 16);
  }
  for (const k of ["name", "tagline", "description"] as const) {
    if (typeof o[k] === "string") o[k] = (o[k] as string).trim();
  }
  if (typeof o.tagline === "string") o.tagline = o.tagline.slice(0, 120);
  if (typeof o.description === "string") o.description = o.description.slice(0, 600);
  return o;
}

export function parseIdeaText(text: string): LaunchIdea {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const json = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
  return LaunchIdea.parse(normalizeIdea(json));
}

export function mockIdea(prompt: string): LaunchIdea {
  const words = prompt.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const stop = new Set(["coin", "token", "meme", "about", "with", "that", "for", "the", "and", "make", "create", "launch"]);
  const base = (words.filter((w) => w.length >= 3 && !stop.has(w)).pop() ?? "nova").slice(0, 8);
  const hash = [...prompt].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const hue = (n: number) => `#${(((hash >> n) & 0xffffff) | 0x404040).toString(16).padStart(6, "0").slice(0, 6)}`;
  const name = base.charAt(0).toUpperCase() + base.slice(1);
  return LaunchIdea.parse(
    normalizeIdea({
      name: `${name} Coin`,
      ticker: `${base}${hash % 100}`,
      tagline: `The community token for ${name.toLowerCase()} lovers on NEAR.`,
      description: `${name} Coin is a playful NEP-141 token born from the prompt "${prompt.slice(0, 200)}". Yeeted onto NEAR ${config.networkId} with Yeetpad.`,
      colors: { primary: hue(0), secondary: hue(4), accent: hue(8), background: "#0b0d12", text: "#f5f7fa" },
    }),
  );
}

/** One log line per LLM call (Workers observability / `wrangler tail`) so token use can be checked. Never the key. */
function logUsage(t: LLMTarget, u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined | null) {
  if (u) console.log(JSON.stringify({ llm_usage: { source: t.source, provider: t.provider ?? null, model: t.model, prompt: u.prompt_tokens, completion: u.completion_tokens, total: u.total_tokens } }));
}

/** Format fallbacks: json_schema → json_object → plain (the reply is parsed + validated either way).
 *  Only a 400/422 (unsupported parameter) moves to the next one; auth/quota errors stop at once. */
const FORMATS = [
  (): Record<string, unknown> => ({ response_format: { type: "json_schema", json_schema: { name: "launch_idea", strict: false, schema: launchIdeaJsonSchema as Record<string, unknown> } } }),
  (): Record<string, unknown> => ({ response_format: { type: "json_object" } }),
  (): Record<string, unknown> => ({}),
];

export async function generateIdea(prompt: string, target?: LLMTarget, client?: OpenAI): Promise<LaunchIdea> {
  if (config.llmMock) return mockIdea(prompt);
  const t = target ?? envTarget();
  try {
    const c = client ?? clientFor(t);
    const messages = [
      { role: "system" as const, content: SYSTEM },
      { role: "user" as const, content: prompt },
    ];
    let text: string | null | undefined;
    for (let i = 0; ; i++) {
      try {
        const r = await c.chat.completions.create({ model: t.model, messages, temperature: 0.9, max_tokens: config.llmMaxTokens, ...FORMATS[i]() } as never);
        const rr = r as unknown as { choices: { message?: { content?: string | null } }[]; usage?: Parameters<typeof logUsage>[1] };
        text = rr.choices[0]?.message?.content;
        logUsage(t, rr.usage);
        break;
      } catch (e) {
        if (i < FORMATS.length - 1 && e instanceof OpenAI.APIError && (e.status === 400 || e.status === 422)) continue;
        throw e;
      }
    }
    if (!text) throw new Error("LLM returned an empty response");
    return parseIdeaText(text);
  } catch (e) {
    throw sanitize(e, t);
  }
}

/** Short per-idea creative angles so parallel calls on the same prompt don't converge on one name. */
export const ANGLES = [
  "a pun", "a mascot character", "retro arcade", "a mock-serious corporation", "a fake sports team", "space",
  "medieval", "a cooking show", "noir detective", "a boy band", "a weather report", "a cult classic movie",
  "a nature documentary", "a heist", "a self-help guru", "a superhero", "a startup pitch", "a soap opera",
  "a road trip", "an old-school RPG", "a fashion label", "a news anchor", "a rock opera", "a kids' cartoon",
];

/** Generates `count` (1-MAX_BATCH) ideas in parallel and makes their tickers unique.
 *  `avoid` = names/tickers already used earlier in a chunked run (only the last few are sent, to keep tokens low).
 *  `seq` = the run position of this chunk's first idea; each idea gets its own angle from ANGLES. */
export async function generateIdeas(prompt: string, count = 1, avoid: string[] = [], seq?: number, target?: LLMTarget): Promise<LaunchIdea[]> {
  const n = Math.max(1, Math.min(MAX_BATCH, Math.floor(count)));
  const recent = avoid.slice(-AVOID_MAX).map((s) => s.slice(0, 24));
  const tail = recent.length ? ` Don't reuse: ${recent.join(", ")}.` : "";
  const variants = Array.from({ length: n }, (_, i) =>
    n === 1 && !tail && seq === undefined
      ? prompt
      : `${prompt}\n\n(Idea ${i + 1} of ${n}: clearly different from the others, own name, ticker and palette.${seq !== undefined ? ` Angle: ${ANGLES[(seq + i) % ANGLES.length]}.` : ""}${tail})`,
  );
  const t = config.llmMock ? target : (target ?? envTarget());
  let client: OpenAI | undefined;
  if (t && !config.llmMock) {
    try {
      client = clientFor(t);
    } catch (e) {
      throw sanitize(e, t);
    }
  }
  const ideas = await Promise.all(variants.map((p) => generateIdea(p, t, client)));
  const seen = new Set<string>(avoid.map((s) => s.toLowerCase()));
  return ideas.map((idea) => {
    let t = idea.ticker;
    for (let k = 2; seen.has(t); k++) t = `${idea.ticker.slice(0, 16 - String(k).length)}${k}`;
    seen.add(t);
    return t === idea.ticker ? idea : { ...idea, ticker: t };
  });
}

/** How many earlier names/tickers go into the prompt (token budget). */
export const AVOID_MAX = 24;

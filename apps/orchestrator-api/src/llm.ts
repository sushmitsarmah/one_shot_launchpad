import OpenAI from "openai";
import { LaunchIdea, launchIdeaJsonSchema } from "@osl/schema";
import { config, configVersion } from "./config";

const SYSTEM = `You are a creative crypto launch strategist for the NEAR ecosystem.
Given a user's prompt, invent ONE token + landing-site idea. Reply with JSON only, matching:
{"name": string (2-40 chars), "ticker": string (2-16 chars, lowercase a-z/0-9, starts with a letter),
 "tagline": string (<=120 chars), "description": string (10-600 chars),
 "colors": {"primary","secondary","accent","background","text"} as #RRGGBB hex}.
Keep it fun but tasteful. Ensure text colour contrasts with background.`;

let client: OpenAI | null = null;
let clientVersion = -1;
function getClient() {
  if (!config.nearAiApiKey) throw new Error("NEARAI_API_KEY is not set (or set LLM_MOCK=1)");
  if (!client || clientVersion !== configVersion()) {
    client = new OpenAI({ baseURL: config.nearAiBaseUrl, apiKey: config.nearAiApiKey });
    clientVersion = configVersion();
  }
  return client;
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

/** One log line per LLM call (Workers observability / `wrangler tail`) so token use can be checked. */
function logUsage(u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined | null) {
  if (u) console.log(JSON.stringify({ llm_usage: { model: config.nearAiModel, prompt: u.prompt_tokens, completion: u.completion_tokens, total: u.total_tokens } }));
}

export async function generateIdea(prompt: string): Promise<LaunchIdea> {
  if (config.llmMock) return mockIdea(prompt);
  const c = getClient();
  const messages = [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: prompt },
  ];
  let text: string | null | undefined;
  try {
    const r = await c.chat.completions.create({
      model: config.nearAiModel,
      messages,
      temperature: 0.9,
      max_tokens: config.llmMaxTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: "launch_idea", strict: false, schema: launchIdeaJsonSchema as Record<string, unknown> },
      },
    });
    text = r.choices[0]?.message?.content;
    logUsage(r.usage);
  } catch (e) {
    // Some models behind the gateway don't support json_schema; fall back to json_object.
    if (!(e instanceof OpenAI.APIError) || (e.status !== 400 && e.status !== 422)) throw e;
    const r = await c.chat.completions.create({
      model: config.nearAiModel,
      messages,
      temperature: 0.9,
      max_tokens: config.llmMaxTokens,
      response_format: { type: "json_object" },
    });
    text = r.choices[0]?.message?.content;
    logUsage(r.usage);
  }
  if (!text) throw new Error("LLM returned an empty response");
  return parseIdeaText(text);
}

/** Generates `count` ideas in parallel and makes their tickers unique. */
export async function generateIdeas(prompt: string, count = 1): Promise<LaunchIdea[]> {
  const n = Math.max(1, Math.min(5, Math.floor(count)));
  const variants = Array.from({ length: n }, (_, i) =>
    n === 1 ? prompt : `${prompt}\n\n(Idea ${i + 1} of ${n}: make it clearly different from the others, with its own name, ticker and palette.)`,
  );
  const ideas = await Promise.all(variants.map((p) => generateIdea(p)));
  const seen = new Set<string>();
  return ideas.map((idea) => {
    let t = idea.ticker;
    for (let k = 2; seen.has(t); k++) t = `${idea.ticker.slice(0, 15 - String(k).length)}${k}`;
    seen.add(t);
    return t === idea.ticker ? idea : { ...idea, ticker: t };
  });
}

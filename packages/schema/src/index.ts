import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour like #12abef");

/** NEAR account id (testnet named or implicit). */
export const NearAccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "invalid NEAR account id");

/** Ticker used as the token sub-account: `<ticker>.<factory>`. Mirrors the factory's validation. */
export const Ticker = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,15}$/, "ticker: 2-16 chars, lowercase a-z/0-9, starts with a letter");

export const LaunchIdea = z.object({
  name: z.string().min(2).max(40),
  ticker: Ticker,
  tagline: z.string().min(3).max(120),
  description: z.string().min(10).max(600),
  colors: z.object({
    primary: hex,
    secondary: hex,
    accent: hex,
    background: hex,
    text: hex,
  }),
});
export type LaunchIdea = z.infer<typeof LaunchIdea>;

export const Blueprint = z.enum(["meme-landing", "utility-landing", "community-hub"]);

export const SiteConfig = z.object({
  siteId: z.string().min(3),
  ownerWallet: NearAccountId,
  ecosystem: z.literal("near"),
  blueprint: Blueprint,
  theme: z.object({
    colors: LaunchIdea.shape.colors,
    fonts: z.object({ heading: z.string(), body: z.string() }),
  }),
  branding: z.object({
    name: z.string(),
    ticker: z.string(),
    tagline: z.string(),
    description: z.string(),
    logoUrl: z.string().url().optional(),
  }),
  tokenLaunch: z.object({
    contractOrMintAddress: z.string(),
    buyUrl: z.string().url(),
    explorerUrl: z.string().url().optional(),
    txHash: z.string().optional(),
    launchedAt: z.number().optional(), // unix ms
  }),
  /** NEP-148 icon (data URI) used for the token. */
  iconDataUri: z.string().optional(),
  /** URL slug from the token name (`/t/<slug>`); unique per token. */
  slug: z.string().optional(),
});
export type SiteConfig = z.infer<typeof SiteConfig>;

// ---------- API contracts ----------

export const MAX_BATCH = 5;

export const GenerateRequest = z.object({
  prompt: z.string().min(3).max(1000),
  /** How many distinct ideas to generate (1-5); each one is charged. */
  count: z.number().int().min(1).max(MAX_BATCH).optional(),
  /** Optional: the account comes from the session; if sent it must match it. */
  ownerWallet: NearAccountId.optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;

export const GenerateResponse = z.object({
  /** First idea (kept for single-idea clients). */
  idea: LaunchIdea,
  ideas: z.array(LaunchIdea),
  charged: z.string(), // yoctoNEAR
  txHash: z.string().nullable(),
});
export type GenerateResponse = z.infer<typeof GenerateResponse>;

export const LaunchRequest = z.object({
  /** Optional: the account comes from the session; if sent it must match it. */
  ownerWallet: NearAccountId.optional(),
  idea: LaunchIdea,
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;

export const LaunchResponse = z.object({
  tokenId: z.string(),
  txHash: z.string(),
  explorerUrl: z.string().url(),
  siteConfig: SiteConfig,
  siteUrl: z.string().url().optional(),
});
export type LaunchResponse = z.infer<typeof LaunchResponse>;

export const BatchLaunchRequest = z.object({
  ownerWallet: NearAccountId.optional(),
  ideas: z.array(LaunchIdea).min(1).max(MAX_BATCH),
});
export type BatchLaunchRequest = z.infer<typeof BatchLaunchRequest>;

export const BatchLaunchItem = z.object({
  ticker: z.string(),
  ok: z.boolean(),
  tokenId: z.string().nullable(),
  slug: z.string().nullable().optional(),
  siteUrl: z.string().url().nullable(),
  error: z.string().nullable(),
});
export type BatchLaunchItem = z.infer<typeof BatchLaunchItem>;

export const BatchLaunchResponse = z.object({
  txHash: z.string(),
  explorerUrl: z.string().url(),
  results: z.array(BatchLaunchItem),
});
export type BatchLaunchResponse = z.infer<typeof BatchLaunchResponse>;

/** A launched token as listed in "My launches" / the token page. */
export const LaunchedToken = z.object({
  ticker: z.string(),
  slug: z.string().nullable(),
  tokenId: z.string(),
  ownerId: z.string(),
  createdAt: z.number(), // unix ms
  name: z.string().nullable(),
  tagline: z.string().nullable(),
  colors: LaunchIdea.shape.colors.nullable(),
  siteUrl: z.string().url(),
  explorerUrl: z.string().url(),
});
export type LaunchedToken = z.infer<typeof LaunchedToken>;

export const BalanceResponse = z.object({
  account: z.string(),
  balance: z.string(), // yoctoNEAR
  balanceNear: z.string(),
});
export type BalanceResponse = z.infer<typeof BalanceResponse>;

/** JSON Schema for LLM structured output (OpenAI `response_format: json_schema`). */
export const launchIdeaJsonSchema = z.toJSONSchema(LaunchIdea, { target: "draft-7" });

/** yoctoNEAR (string/bigint) -> human NEAR string, 4 decimals. */
export function formatNear(yocto: string | bigint, decimals = 4): string {
  const v = BigInt(yocto);
  const base = 10n ** 24n;
  const whole = v / base;
  const frac = (v % base).toString().padStart(24, "0").slice(0, decimals);
  return `${whole}.${frac}`;
}

/** Human NEAR ("1.5") -> yoctoNEAR string. */
export function parseNear(near: string): string {
  const [w, f = ""] = near.trim().split(".");
  if (!/^\d*$/.test(w ?? "") || !/^\d*$/.test(f) || f.length > 24) throw new Error("bad NEAR amount");
  return (BigInt(w || "0") * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24))).toString();
}

// ---------- auth (NEP-413 sign-in -> session token) ----------

/** Body of POST /api/auth/session: a NEP-413 signed message returned by the wallet. */
export const SessionRequest = z.object({
  accountId: NearAccountId,
  publicKey: z.string().min(10).max(200), // "ed25519:<base58>"
  signature: z.string().min(10).max(200), // base64 (or base58) of the 64-byte ed25519 signature
  message: z.string().min(10).max(1000),
  nonce: z.string().min(10).max(100), // base64 of 32 bytes
  recipient: z.string().min(2).max(200),
  callbackUrl: z.string().max(500).nullish(),
});
export type SessionRequest = z.infer<typeof SessionRequest>;

export const SessionResponse = z.object({
  token: z.string(),
  accountId: NearAccountId,
  expiresAt: z.number(), // unix ms
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Canonical sign-in message. The API parses `account` and `issued` back out of it. */
export const SIGN_IN_TITLE = "Sign in to Yeetpad";
export function buildSignInMessage(accountId: string, issuedAt: Date = new Date()): string {
  return `${SIGN_IN_TITLE}\naccount: ${accountId}\nissued: ${issuedAt.toISOString()}`;
}
export function parseSignInMessage(message: string): { accountId: string; issuedAt: number } | null {
  // The pre-rebrand title is still accepted so tabs opened before the rename keep working.
  const m = /^Sign in to (?:Yeetpad|One Shot Launchpad)\naccount: (\S+)\nissued: (\S+)$/.exec(message);
  if (!m) return null;
  const issuedAt = Date.parse(m[2]);
  return Number.isFinite(issuedAt) ? { accountId: m[1], issuedAt } : null;
}

/** URL slug from a token name: lowercase, ASCII-folded, non-alphanumerics -> '-', max 40 chars. */
export function slugify(name: string, max = 40): string {
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/g, "");
}

/** Path ids accepted by /t/<id> and /api/site/<id>: a ticker or a slug. */
export const SITE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

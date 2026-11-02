import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour like #12abef");

/** NEAR account id (testnet named or implicit). */
export const NearAccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "invalid NEAR account id");

/**
 * Can this account receive on NEAR mainnet? A named sub-account of a mainnet top-level account (name.near,
 * name.tg, ...), NEAR implicit (64 hex) or ETH-implicit (0x + 40 hex). Never a `.testnet` name: that account only
 * exists on testnet, so mainnet funds sent to it would be lost.
 */
export function isNearMainnetAccount(a: string): boolean {
  if (typeof a !== "string" || a.length < 2 || a.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(a) || /^0x[0-9a-f]{40}$/.test(a)) return true;
  return !/\.(testnet|betanet)$/.test(a) && /^(([a-z\d]+[-_])*[a-z\d]+\.)+([a-z\d]+[-_])*[a-z\d]+$/.test(a);
}
export const MainnetAccountId = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isNearMainnetAccount, "enter a NEAR mainnet account (like name.near, or a 64-hex / 0x implicit account), not a .testnet one");

/** Ticker used as the token sub-account: `<ticker>.<factory>`. Mirrors the factory's validation. */
export const Ticker = z
  .string()
  .regex(/^[a-z][a-z0-9]{1,15}$/, "ticker: 2-16 chars, lowercase a-z/0-9, starts with a letter");

export const LaunchIdea = z.object({
  name: z.string().trim().min(2).max(40),
  ticker: Ticker,
  tagline: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(600),
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
  /** Soft delete ("taken down"): the page shows a 410; cleared by POST /api/tokens/restore. */
  takenDown: z.object({ at: z.number(), by: z.string(), byAdmin: z.boolean().optional() }).optional(),
  /** Creator-owned settings (set via PUT /api/site/:id/settings by the owner only). */
  analytics: z.object({ gaId: z.string().regex(/^G-[A-Z0-9]{4,12}$/).optional() }).optional(),
});
export type SiteConfig = z.infer<typeof SiteConfig>;

// ---------- API contracts ----------

import { MAX_BATCH, MAX_RUN } from "./limits";
export { MAX_BATCH, MAX_RUN };

export const GenerateRequest = z.object({
  prompt: z.string().min(3).max(1000),
  /** How many distinct ideas this request generates (1-MAX_BATCH); each one is charged. Runs of up to MAX_RUN loop client-side. */
  count: z.number().int().min(1).max(MAX_BATCH).optional(),
  /** Names/tickers already used earlier in this run, so the LLM avoids them (short; kept small for tokens). */
  avoid: z.array(z.string().max(40)).max(MAX_RUN * 2).optional(),
  /** Position of this chunk's first idea in the run (0-based); gives each idea its own creative angle. */
  seq: z.number().int().min(0).max(MAX_RUN * 3).optional(),
  /** Optional: the account comes from the session; if sent it must match it. */
  ownerWallet: NearAccountId.optional(),
  /** Use the platform key (normal AI fee) even if the caller saved their own key. Only sent after the user chose it. */
  usePlatformKey: z.boolean().optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;

export const GenerateResponse = z.object({
  /** First idea (kept for single-idea clients). */
  idea: LaunchIdea,
  ideas: z.array(LaunchIdea),
  charged: z.string(), // yoctoNEAR
  txHash: z.string().nullable(),
  /** Which key ran the request: the caller's own (no AI fee), the admin-set platform key, or the env fallback. */
  keySource: z.enum(["user", "platform", "env"]).optional(),
  provider: z.string().nullable().optional(),
  model: z.string().optional(),
});
export type GenerateResponse = z.infer<typeof GenerateResponse>;

/** Where a launch is listed. none = our factory token only; rhea = our token + Rhea DCL pool (vault);
 *  nearly / justhoot = that venue's factory creates the token, signed by the creator's wallet. */
export const ListOn = z.enum(["none", "rhea", "nearly", "justhoot"]);
export type ListOn = z.infer<typeof ListOn>;

export const RheaOptions = z.object({
  /** Opening fully-diluted valuation in NEAR; sets the pool's starting price. */
  openingFdvNear: z.number().positive().max(1e9).optional(),
  /** Share of supply sent to the creator instead of the pool (0-90). */
  creatorPct: z.number().min(0).max(90).optional(),
});
export type RheaOptions = z.infer<typeof RheaOptions>;

export const Listing = z.object({
  venue: z.enum(["rhea", "nearly", "justhoot"]),
  ok: z.boolean(),
  tokenId: z.string().nullable(),
  poolId: z.string().nullable(),
  lptId: z.string().nullable(),
  url: z.string().url().nullable(),
  txHash: z.string().nullable(),
  error: z.string().nullable(),
});
export type Listing = z.infer<typeof Listing>;

export const LaunchRequest = z.object({
  /** Optional: the account comes from the session; if sent it must match it. */
  ownerWallet: NearAccountId.optional(),
  idea: LaunchIdea,
  listOn: z.enum(["none", "rhea"]).optional(),
  rhea: RheaOptions.optional(),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;

export const LaunchResponse = z.object({
  tokenId: z.string(),
  txHash: z.string(),
  explorerUrl: z.string().url(),
  siteConfig: SiteConfig,
  siteUrl: z.string().url().optional(),
  listing: Listing.nullable().optional(),
});
export type LaunchResponse = z.infer<typeof LaunchResponse>;

export const BatchLaunchRequest = z.object({
  ownerWallet: NearAccountId.optional(),
  ideas: z.array(LaunchIdea).min(1).max(MAX_BATCH),
  listOn: z.enum(["none", "rhea"]).optional(),
  rhea: RheaOptions.optional(),
});
export type BatchLaunchRequest = z.infer<typeof BatchLaunchRequest>;

export const BatchLaunchItem = z.object({
  ticker: z.string(),
  ok: z.boolean(),
  tokenId: z.string().nullable(),
  slug: z.string().nullable().optional(),
  siteUrl: z.string().url().nullable(),
  error: z.string().nullable(),
  listing: Listing.nullable().optional(),
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
  views: z.number().int().nonnegative().optional(),
  gaId: z.string().nullable().optional(),
  tokenId: z.string(),
  ownerId: z.string(),
  createdAt: z.number(), // unix ms
  name: z.string().nullable(),
  tagline: z.string().nullable(),
  colors: LaunchIdea.shape.colors.nullable(),
  siteUrl: z.string().url(),
  explorerUrl: z.string().url(),
  /** Where it trades: our factory token (yeetpad), listed on Rhea, or a Nearly token. */
  venue: z.enum(["yeetpad", "rhea", "nearly", "justhoot"]).optional(),
  venueUrl: z.string().url().nullable().optional(),
  /** Launch transaction (from the stored site config, when known). */
  txHash: z.string().nullable().optional(),
  /** Set when the creator (or an admin) took the token's site down (only listed with ?includeDeleted=1). */
  deletedAt: z.number().nullable().optional(),
  deletedByAdmin: z.boolean().optional(),
  /** NEAR Intents widget settings for the token page (absent = off). */
  intents: z.lazy(() => IntentsConfig).optional(),
  /** Loofta "pay the creator" widget state (never the payout target). */
  loofta: z.object({ enabled: z.boolean(), ready: z.boolean(), custom: z.boolean() }).optional(),
  /** What the NEAR Intents widget actually offers on this page (tip needs a mainnet recipient). */
  intentsState: z.object({ tip: z.boolean(), buy: z.boolean(), recipient: z.string().nullable(), notes: z.array(z.string()) }).optional(),
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

/** Google Analytics 4 measurement id. Strict: only this shape is ever injected into token pages. */
export const GA_ID_RE = /^G-[A-Z0-9]{4,12}$/;
export const SiteSettingsRequest = z.object({
  /** Set to a GA4 id, or null / "" to clear. */
  gaId: z.union([z.string().trim().toUpperCase().regex(GA_ID_RE, "gaId must look like G-XXXXXXXX"), z.literal(""), z.null()]),
});
export type SiteSettingsRequest = z.infer<typeof SiteSettingsRequest>;

// ---------- access gate / whitelist ----------
/** Error code returned (HTTP 403) when the app is locked and the account is not on the allowlist. */
export const NOT_WHITELISTED = "not_whitelisted";
export const WAITLIST_CONTACT_MAX = 100;
const EMAIL_RE = /^[^\s@<>"'`]{1,64}@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/;
const HANDLE_RE = /^@[A-Za-z0-9_.-]{1,50}$/;
/** Optional contact for the whitelist: an email or an @handle (X/Telegram/Discord). */
export const WaitlistContact = z
  .string()
  .trim()
  .max(WAITLIST_CONTACT_MAX, `contact must be at most ${WAITLIST_CONTACT_MAX} characters`)
  .refine((s) => s === "" || EMAIL_RE.test(s) || HANDLE_RE.test(s), "contact must be an email or an @handle");
export const WaitlistRequest = z.object({
  account: z.string().trim().toLowerCase().pipe(NearAccountId),
  contact: WaitlistContact.optional().nullable(),
});
export type WaitlistRequest = z.infer<typeof WaitlistRequest>;
export const WaitlistResponse = z.object({ ok: z.literal(true), account: z.string(), already: z.boolean() });
export type WaitlistResponse = z.infer<typeof WaitlistResponse>;

// ---------- admin ----------
export const NOT_ADMIN = "not_admin";
export const ADMIN_BATCH_MAX = 100;
/** Body of POST /api/admin/{approve,revoke,remove}. */
export const AdminAccountsRequest = z.object({
  accounts: z.array(z.string().trim().toLowerCase().pipe(NearAccountId)).min(1).max(ADMIN_BATCH_MAX),
});
export type AdminAccountsRequest = z.infer<typeof AdminAccountsRequest>;
export type WaitlistStatus = "pending" | "approved" | "revoked";
export interface AdminWaitlistItem {
  account: string;
  contact: string | null;
  joinedAt: number;
  status: WaitlistStatus;
  approvedAt: number | null;
  approvedBy: string | null;
}
export interface AdminAllowedItem {
  account: string;
  source: "admin" | "env" | "kv";
  approvedAt: number | null;
  approvedBy: string | null;
}
export interface AdminResult {
  account: string;
  ok: boolean;
  note?: string;
}
export interface MeResponse {
  accountId: string;
  isAdmin: boolean;
  whitelisted: boolean;
  locked: boolean;
}

// ---------- venue quotes + Nearly ----------

export const QuoteRequest = z.object({
  ideas: z.array(LaunchIdea).min(1).max(MAX_BATCH),
  listOn: ListOn,
  rhea: RheaOptions.optional(),
  /** JustHoot: per-ticker browser-made icon, so the deposit quote matches what will be signed. */
  icons: z.record(z.string(), z.string().max(20_000)).optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequest>;

export const QuoteItem = z.object({
  ticker: z.string(),
  /** yoctoNEAR */
  total: z.string(),
  parts: z.record(z.string(), z.string()),
  /** vault credit (none/rhea) or the creator's wallet (nearly) */
  paidFrom: z.enum(["credit", "wallet"]),
});
export const QuoteResponse = z.object({
  listOn: ListOn,
  items: z.array(QuoteItem),
  total: z.string(),
  notes: z.array(z.string()),
  rhea: z.object({ openingFdvNear: z.number(), creatorPct: z.number(), initPoint: z.number().nullable() }).optional(),
});
export type QuoteResponse = z.infer<typeof QuoteResponse>;

export const NearlyPrepareRequest = z.object({ ideas: z.array(LaunchIdea).min(1).max(MAX_BATCH) });
export const NearlyLaunchTx = z.object({
  ticker: z.string(),
  slug: z.string(),
  receiverId: z.string(),
  methodName: z.enum(["launch", "launch_meme"]),
  args: z.record(z.string(), z.unknown()),
  gas: z.string(),
  deposit: z.string(),
});
export type NearlyLaunchTx = z.infer<typeof NearlyLaunchTx>;
export const NearlyPrepareResponse = z.object({ factory: z.string(), chunk: z.number(), txs: z.array(NearlyLaunchTx), total: z.string() });
export type NearlyPrepareResponse = z.infer<typeof NearlyPrepareResponse>;

export const NearlyFinalizeRequest = z.object({
  items: z.array(z.object({ ticker: Ticker, txHash: z.string().min(20).max(64) })).min(1).max(MAX_BATCH),
});
export const NearlyFinalizeResponse = z.object({ results: z.array(BatchLaunchItem) });
export type NearlyFinalizeResponse = z.infer<typeof NearlyFinalizeResponse>;

// ---------- JustHoot (same wallet-signed shape as Nearly) ----------
export const JusthootPrepareRequest = z.object({
  ideas: z.array(LaunchIdea).min(1).max(MAX_BATCH),
  /** Optional per-ticker raster icon (data:image/webp, 128 px) made in the browser; must be <= 7000 chars. */
  icons: z.record(z.string(), z.string().max(20_000)).optional(),
});
export type JusthootPrepareRequest = z.infer<typeof JusthootPrepareRequest>;
export const JusthootPrepareResponse = NearlyPrepareResponse;
export type JusthootPrepareResponse = NearlyPrepareResponse;
export const JusthootFinalizeRequest = NearlyFinalizeRequest;
export const JusthootFinalizeResponse = NearlyFinalizeResponse;
export type JusthootFinalizeResponse = NearlyFinalizeResponse;

export { tokenIconDataUri, tokenIconSvg } from "./icon";
export * from "./run";
export * from "./validate";

// ---------- take down / restore a token's Yeetpad site (soft delete; the token stays on chain) ----------
export const TOKENS_DELETE_MAX = 50;
export const TokensActionRequest = z.object({ tokens: z.array(Ticker).min(1).max(TOKENS_DELETE_MAX) });
export type TokensActionRequest = z.infer<typeof TokensActionRequest>;
export interface TokensActionResult {
  ticker: string;
  ok: boolean;
  note?: string;
}


// ---------- NEAR Intents (1Click) widget on token pages ----------
/**
 * buy = visitor pays any supported asset, 1Click delivers wNEAR to their NEAR account, then they swap
 * wNEAR -> the token on Rhea with their wallet (1Click can't route into new tokens directly).
 * tip = visitor pays any supported asset, 1Click delivers it to the creator as USDC or wNEAR on NEAR.
 */
export const INTENTS_MODES = ["buy", "tip", "both"] as const;
export const IntentsMode = z.enum(INTENTS_MODES);
export type IntentsMode = z.infer<typeof IntentsMode>;
export const IntentsConfig = z.object({
  enabled: z.boolean(),
  mode: IntentsMode.default("both"),
  /**
   * Per-page NEAR mainnet tip recipient. Falls back to the creator's mainnet payout account (Studio), then, on
   * mainnet deployments only, the creator's own account. Must be a mainnet account (checked on save and use).
   */
  recipient: NearAccountId.optional(),
  /** What tips arrive as on NEAR. */
  tipAsset: z.enum(["usdc", "wnear"]).default("usdc"),
});
export type IntentsConfig = z.infer<typeof IntentsConfig>;
export const INTENTS_TOKENS_MAX = TOKENS_DELETE_MAX;
export const TokensIntentsRequest = z.object({
  tokens: z.array(Ticker).min(1).max(INTENTS_TOKENS_MAX),
  intents: IntentsConfig,
});
export type TokensIntentsRequest = z.infer<typeof TokensIntentsRequest>;
/** A 1Click asset id as listed by /v0/tokens (e.g. nep141:wrap.near, 1cs_v1:btc:native:coin). */
export const IntentsAssetId = z.string().min(3).max(200).regex(/^[A-Za-z0-9_.:\-|]+$/, "invalid asset id");
export const IntentsQuoteRequest = z.object({
  /** Token page id (slug or ticker). */
  site: z.string().min(2).max(64),
  mode: z.enum(["buy", "tip"]),
  originAsset: IntentsAssetId,
  /** Amount of originAsset in its smallest unit. */
  amount: z.string().regex(/^[1-9][0-9]{0,38}$/, "amount must be a positive integer in base units"),
  /** Visitor's refund address on the origin chain (required for a real deposit address). */
  refundTo: z.string().trim().min(3).max(128).regex(/^[A-Za-z0-9._:\-]+$/, "refund address has invalid characters").optional(),
  /** buy: the visitor's NEAR mainnet account that receives wNEAR (required for a real deposit address). */
  recipient: NearAccountId.optional(),
  /** Price check only: no deposit address. 1Click is always mainnet, on every Yeetpad deployment. */
  dry: z.boolean().optional(),
  slippageBps: z.number().int().min(10).max(500).optional(),
});
export type IntentsQuoteRequest = z.infer<typeof IntentsQuoteRequest>;
/** The creator's default NEAR mainnet account for Intents tips (null clears it). */
export const IntentsPayoutRequest = z.object({ account: MainnetAccountId.nullable() }).strict();
export type IntentsPayoutRequest = z.infer<typeof IntentsPayoutRequest>;
export interface IntentsSettings {
  /** Saved mainnet payout account, or null. */
  payout: string | null;
  /** Where tips go on a page without its own recipient (payout, else the creator on mainnet deployments), or null = tips hidden. */
  tipRecipient: string | null;
  network: "testnet" | "mainnet";
}
// ---------- AI keys (bring your own key) ----------
/** Fixed allowlist; the API rejects anything else (no custom base URLs). */
export const LLM_PROVIDERS = ["nearai", "ollama"] as const;
export const LlmProvider = z.enum(LLM_PROVIDERS);
export type LlmProvider = z.infer<typeof LlmProvider>;
export const LLM_KEY_MAX = 512;

/** PUT /api/llm/key (and /api/admin/llm-key). apiKey may be omitted to change only the model of a saved key. */
export const LlmKeyRequest = z
  .object({
    provider: LlmProvider,
    apiKey: z.string().max(LLM_KEY_MAX * 4).optional(),
    model: z.string().min(1).max(128).optional(),
  })
  .strict();
export type LlmKeyRequest = z.infer<typeof LlmKeyRequest>;

export const LlmModelsRequest = z.object({ provider: LlmProvider, apiKey: z.string().max(LLM_KEY_MAX * 4).optional() }).strict();
export type LlmModelsRequest = z.infer<typeof LlmModelsRequest>;

export interface LlmProviderInfo {
  id: LlmProvider;
  label: string;
  baseUrl: string;
  keysUrl: string;
  defaultModels: string[];
}
/** Never contains the key: only provider, model, last 4 characters, dates and validity. */
export interface LlmKeySummary {
  provider: LlmProvider;
  providerLabel: string;
  model: string;
  last4: string | null;
  createdAt: number;
  updatedAt: number;
  valid: boolean;
  validatedAt: number;
  lastError: string | null;
}
export interface LlmModel {
  id: string;
  price?: number;
}
export interface PlatformKeyInfo {
  stored: LlmKeySummary | null;
  env: { configured: boolean; baseUrl: string; provider: LlmProvider | null; model: string; last4: string | null };
  /** What generation uses now: the stored platform key when it's valid, else the env secret. */
  active: "platform" | "env";
}

// ---------- Loofta (pay the creator by email / social handle / Loofta account) on token pages ----------
/**
 * Loofta (loofta.com) has two routes, picked server-side per page:
 *  - "checkout": the creator saved their own Loofta integrator API key; the API creates a fresh Loofta payment
 *    link per payment (POST /payment-links) that pays the creator's Loofta account. Nothing about the creator
 *    is revealed to visitors.
 *  - "send": no key needed; opens Loofta's Send page with the creator's payout target (email, social handle or
 *    Loofta username) filled in. The target is stored encrypted and only handed out per click, never in page config.
 */
export const LOOFTA_SOCIALS = ["twitter", "discord", "github", "telegram"] as const;
export const LooftaSocial = z.enum(LOOFTA_SOCIALS);
export type LooftaSocial = z.infer<typeof LooftaSocial>;
export const LOOFTA_SOCIAL_LABEL: Record<LooftaSocial, string> = { twitter: "X", discord: "Discord", github: "GitHub", telegram: "Telegram" };
const LOOFTA_HANDLE_RE: Record<LooftaSocial, RegExp> = {
  twitter: /^[A-Za-z0-9_]{1,15}$/,
  discord: /^[a-z0-9_.]{2,32}$/,
  github: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
  telegram: /^[A-Za-z][A-Za-z0-9_]{4,31}$/,
};
export const looftaHandleOk = (platform: LooftaSocial, handle: string) => LOOFTA_HANDLE_RE[platform].test(handle);
const stripAt = (s: string) => s.trim().replace(/^@+/, "");
export const LooftaPayTo = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), value: z.string().trim().toLowerCase().max(254).pipe(z.email("enter a valid email address")) }).strict(),
  z
    .object({ kind: z.literal("social"), platform: LooftaSocial, value: z.string().max(64).transform(stripAt) })
    .strict()
    .refine((p) => looftaHandleOk(p.platform, p.value), { message: "that isn't a valid handle for this platform", path: ["value"] }),
  z
    .object({ kind: z.literal("username"), value: z.string().max(64).transform((s) => stripAt(s).toLowerCase()) })
    .strict()
    .refine((p) => /^[a-z0-9][a-z0-9_.-]{1,31}$/.test(p.value), { message: "that isn't a valid Loofta username", path: ["value"] }),
]);
export type LooftaPayTo = z.infer<typeof LooftaPayTo>;
export const LOOFTA_ROUTES = ["checkout", "send"] as const;
export type LooftaRoute = (typeof LOOFTA_ROUTES)[number];
/** Per-page toggle. payTo: omitted = keep the page's current override, null = clear it (use the creator's settings). */
export const LooftaToggle = z.object({ enabled: z.boolean(), payTo: LooftaPayTo.nullable().optional() }).strict();
export type LooftaToggle = z.infer<typeof LooftaToggle>;
export const TokensLooftaRequest = z.object({ tokens: z.array(Ticker).min(1).max(TOKENS_DELETE_MAX), loofta: LooftaToggle }).strict();
export type TokensLooftaRequest = z.infer<typeof TokensLooftaRequest>;
/** What the token page and the public launches list get: no payout target, only a masked label. */
export interface LooftaPublic {
  enabled: true;
  route: LooftaRoute;
  /** e.g. "the creator's Loofta account", "@name on X", "j•••@gmail.com". */
  label: string;
  /** Always false: Loofta is live on every deployment (kept for older cached pages). */
  preview: boolean;
}
/** On LaunchedToken (public): on/off, whether a route exists, and whether this page has its own payout target. */
export interface LooftaPageState {
  enabled: boolean;
  ready: boolean;
  custom: boolean;
}
export const LOOFTA_AMOUNT_MIN = 1;
export const LOOFTA_AMOUNT_MAX = 10_000;
export const LooftaCheckoutRequest = z
  .object({
    site: z.string().min(2).max(64),
    /** USD. */
    amount: z.number().finite().min(LOOFTA_AMOUNT_MIN).max(LOOFTA_AMOUNT_MAX).refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "at most 2 decimals"),
    message: z.string().max(200).optional(),
  })
  .strict();
export type LooftaCheckoutRequest = z.infer<typeof LooftaCheckoutRequest>;
export interface LooftaKeySummary {
  last4: string | null;
  createdAt: number;
  updatedAt: number;
  valid: boolean;
  validatedAt: number;
  lastError: string | null;
}
export interface LooftaPayToSummary {
  kind: LooftaPayTo["kind"];
  platform?: LooftaSocial;
  /** Masked for email; the handle/username as is. Only ever shown to the creator. */
  display: string;
}
export interface LooftaSettings {
  enabled: boolean;
  key: LooftaKeySummary | null;
  payTo: LooftaPayToSummary | null;
  /** Which route a page without its own target uses: checkout (key) > send (payout target) > none. */
  route: LooftaRoute | null;
  network: "testnet" | "mainnet";
}

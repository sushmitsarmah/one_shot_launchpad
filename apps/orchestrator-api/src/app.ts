import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import {
  BatchLaunchRequest,
  GenerateRequest,
  LaunchRequest,
  SITE_ID_RE,
  SiteSettingsRequest,
  Ticker,
  type BatchLaunchResponse,
  type LaunchedToken,
  SessionRequest,
  NearAccountId,
  SiteConfig,
  WaitlistRequest,
  formatNear,
  type WaitlistResponse,
  type GenerateResponse,
  type LaunchResponse,
} from "@osl/schema";
import { config } from "./config";
import { generateIdeas } from "./llm";
import { tokenIconDataUri } from "./icon";
import { buildSiteConfig, compactSite, findSite, getSite, getViews, kvStore, putSite, saveSite, siteStoreKind, siteUrl } from "./sites";
import { WAITLIST_MAX_BODY, addToWaitlist, assertAllowed, takeRateLimit } from "./gate";
import { AuthError, consumeNonceInMemory, issueSession, verifySession, verifySignIn } from "./auth";
import {
  deductAiCompute,
  executeSponsoredLaunch,
  executeSponsoredLaunchBatch,
  getRequiredLaunchDeposit,
  getTokenRecord,
  getTokensByOwner,
  getVaultBalance,
  isFullAccessKey,
  isTickerTaken,
  type TokenArgs,
  type TokenRecord,
} from "./near";

type Env = { Bindings: Record<string, unknown>; Variables: { account: string } };
export const app = new Hono<Env>();

// Used only when SESSION_SECRET is unset (local dev): random per process, so sessions don't survive restarts.
let ephemeralSecret: string | null = null;
function sessionSecret(): string {
  if (config.sessionSecret) return config.sessionSecret;
  if (!ephemeralSecret) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    ephemeralSecret = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    console.warn("SESSION_SECRET not set; using a random per-process secret (sessions reset on restart)");
  }
  return ephemeralSecret;
}

app.use(
  "/api/*",
  cors({
    // Resolved per request so Worker env bindings (applied on first request) are honoured.
    origin: (origin) => (config.corsOrigins.includes("*") ? "*" : config.corsOrigins.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  }),
);

app.onError((err, c) => {
  if (err instanceof AuthError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status as 401 | 403);
  console.error(err);
  const msg = err instanceof Error ? err.message : String(err);
  const status = /insufficient balance/i.test(msg) ? 402 : 500;
  return c.json({ error: msg }, status);
});

app.get("/", (c) => c.json({ ok: true, service: "yeetpad orchestrator", network: config.networkId }));
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    llmMock: config.llmMock,
    nearMock: config.nearMock,
    model: config.nearAiModel,
    vault: config.vaultContract,
    factory: config.factoryContract,
    aiComputeCost: config.aiComputeCostYocto,
    maxBatch: 5,
    siteStore: siteStoreKind(),
    siteBase: config.siteBase,
    locked: config.locked,
  }),
);

app.get("/api/balance/:account", async (c) => {
  const account = NearAccountId.safeParse(c.req.param("account"));
  if (!account.success) return c.json({ error: "invalid account id" }, 400);
  const bal = await getVaultBalance(account.data);
  return c.json({ account: account.data, balance: bal.toString(), balanceNear: formatNear(bal) });
});

// ---------- auth ----------
/** Exchange a NEP-413 signed sign-in message for a ~24h session token. */
app.post("/api/auth/session", async (c) => {
  const body = SessionRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const accountId = await verifySignIn(body.data, {
    recipient: config.authRecipient,
    // In NEAR_MOCK mode there is no chain to ask; the signature itself is still verified.
    isFullAccessKey: config.nearMock ? undefined : isFullAccessKey,
    consumeNonce: (n, exp) => consumeNonceInMemory(n, exp),
  });
  // Checked after the signature, so the allowlist can't be probed without the account's key.
  assertAllowed(accountId, config);
  return c.json(await issueSession(accountId, sessionSecret()));
});

/** Requires `Authorization: Bearer <session token>`; sets c.var.account. */
const requireSession = createMiddleware<Env>(async (c, next) => {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  if (!m) throw new AuthError("missing session: sign in with your wallet");
  c.set("account", await verifySession(m[1], sessionSecret()));
  await next();
});

/** While locked, only allowlisted accounts pass (rejects older sessions of non-allowlisted accounts). */
const requireAllowed = createMiddleware<Env>(async (c, next) => {
  assertAllowed(c.var.account, config);
  await next();
});

app.get("/api/auth/me", requireSession, (c) => c.json({ accountId: c.var.account }));

function ownerFor(c: { var: { account: string } }, claimed?: string) {
  if (claimed && claimed !== c.var.account) throw new AuthError(`ownerWallet ${claimed} does not match the signed-in account`, 403);
  return c.var.account;
}

app.post("/api/generate", requireSession, requireAllowed, async (c) => {
  const body = GenerateRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const { prompt } = body.data;
  const count = body.data.count ?? 1;
  const ownerWallet = ownerFor(c, body.data.ownerWallet);
  const cost = BigInt(config.aiComputeCostYocto) * BigInt(count);

  const bal = await getVaultBalance(ownerWallet);
  if (bal < cost) {
    return c.json({ error: `insufficient vault balance: need ${formatNear(cost)} NEAR for ${count} idea(s), have ${formatNear(bal)}` }, 402);
  }

  const ideas = await generateIdeas(prompt, count);
  // Charge only after valid ideas were produced (one charge for the whole set).
  const txHash = cost > 0n ? await deductAiCompute(ownerWallet, cost) : null;
  const res: GenerateResponse = { idea: ideas[0], ideas, charged: cost.toString(), txHash };
  return c.json(res);
});

app.post("/api/launch", requireSession, requireAllowed, async (c) => {
  const body = LaunchRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const { idea } = body.data;
  const ownerWallet = ownerFor(c, body.data.ownerWallet);
  const tokenAccount = `${idea.ticker}.${config.factoryContract}`;

  if (await isTickerTaken(idea.ticker)) {
    return c.json({ error: `ticker "${idea.ticker}" is taken (${tokenAccount}); edit it and retry` }, 409);
  }
  const deposit = await getRequiredLaunchDeposit();
  const bal = await getVaultBalance(ownerWallet);
  if (bal < deposit) {
    return c.json({ error: `insufficient vault balance: launch needs ~${formatNear(deposit)} NEAR, have ${formatNear(bal)}` }, 402);
  }

  const icon = tokenIconDataUri(idea);
  const { tokenId, txHash } = await executeSponsoredLaunch(ownerWallet, tokenArgs(idea, icon), deposit);
  if (!tokenId) {
    return c.json({ error: "launch failed on-chain; your balance was refunded", txHash, explorerUrl: `${config.explorerBase}/txns/${txHash}` }, 502);
  }

  const siteConfig = await putSite(buildSiteConfig(ownerWallet, idea, tokenId, { txHash, icon }));
  const res: LaunchResponse = {
    tokenId,
    txHash,
    explorerUrl: `${config.explorerBase}/txns/${txHash}`,
    siteConfig,
    siteUrl: siteUrl(siteConfig.slug ?? idea.ticker),
  };
  return c.json(res);
});

function tokenArgs(idea: import("@osl/schema").LaunchIdea, icon: string): TokenArgs {
  return {
    ticker: idea.ticker,
    name: idea.name,
    symbol: idea.ticker.toUpperCase(),
    icon,
    decimals: config.tokenDecimals,
    total_supply: config.tokenTotalSupply,
    site: compactSite(idea),
  };
}

/** Launch 1-5 ideas in one vault call; each item is charged/refunded on its own. */
app.post("/api/launch/batch", requireSession, requireAllowed, async (c) => {
  const body = BatchLaunchRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const ownerWallet = ownerFor(c, body.data.ownerWallet);
  const ideas = body.data.ideas;

  const tickers = ideas.map((i) => i.ticker);
  const dup = tickers.find((t, i) => tickers.indexOf(t) !== i);
  if (dup) return c.json({ error: `duplicate ticker "${dup}" in batch` }, 400);
  const taken = (await Promise.all(tickers.map(async (t) => ((await isTickerTaken(t)) ? t : null)))).filter(Boolean);
  if (taken.length) return c.json({ error: `ticker(s) taken: ${taken.join(", ")}; edit and retry`, taken }, 409);

  const deposit = await getRequiredLaunchDeposit();
  const need = deposit * BigInt(ideas.length);
  const bal = await getVaultBalance(ownerWallet);
  if (bal < need) {
    return c.json({ error: `insufficient vault balance: ${ideas.length} launch(es) need ~${formatNear(need)} NEAR, have ${formatNear(bal)}` }, 402);
  }

  const icons = ideas.map((i) => tokenIconDataUri(i));
  const { txHash, results } = await executeSponsoredLaunchBatch(
    ownerWallet,
    ideas.map((idea, i) => tokenArgs(idea, icons[i])),
    deposit,
  );
  const out: BatchLaunchResponse["results"] = [];
  for (const [i, r] of results.entries()) {
    if (r.tokenId) {
      const site = await putSite(buildSiteConfig(ownerWallet, ideas[i], r.tokenId, { txHash, icon: icons[i] }));
      out.push({ ticker: r.ticker, ok: true, tokenId: r.tokenId, slug: site.slug ?? null, siteUrl: siteUrl(site.slug ?? r.ticker), error: null });
    } else {
      out.push({ ticker: r.ticker, ok: false, tokenId: null, slug: null, siteUrl: null, error: "launch failed on-chain; that item was refunded" });
    }
  }
  const res: BatchLaunchResponse = { txHash, explorerUrl: `${config.explorerBase}/txns/${txHash}`, results: out };
  return c.json(res, out.some((r) => r.ok) ? 200 : 502);
});

// ---------- whitelist (waitlist) ----------
/**
 * Join the waitlist. Public, idempotent, soft rate-limited per IP. Stored as `waitlist:<account>` in the
 * SITES KV namespace; there is deliberately no listing endpoint (read it with `wrangler kv key list`).
 */
app.post("/api/whitelist", async (c) => {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > WAITLIST_MAX_BODY) return c.json({ error: "request too large" }, 413);
  const text = await c.req.text().catch(() => "");
  if (text.length > WAITLIST_MAX_BODY) return c.json({ error: "request too large" }, 413);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const body = WaitlistRequest.safeParse(json);
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid request", issues: body.error.issues }, 400);
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!(await takeRateLimit(kvStore(), ip))) return c.json({ error: "too many signups from here; try again later" }, 429);
  const { already } = await addToWaitlist(kvStore(), body.data);
  const res: WaitlistResponse = { ok: true, account: body.data.account, already };
  return c.json(res);
});

// ---------- token sites (public) ----------

function parseCompact(site: string | null): { tagline?: string; description?: string; colors?: LaunchedToken["colors"] } {
  if (!site) return {};
  try {
    return JSON.parse(site);
  } catch {
    return {};
  }
}

/** SiteConfig for /t/<ticker>: KV first, then rebuilt from the on-chain factory record. */
app.get("/api/site/:id", async (c) => {
  const id = c.req.param("id").toLowerCase();
  if (!SITE_ID_RE.test(id)) return c.json({ error: "invalid ticker or slug" }, 400);
  const found = await findSite(id);
  if (found) {
    const kv = found.site;
    return c.json({ source: "kv", siteConfig: kv, siteUrl: siteUrl(kv.slug ?? id), views: await getViews(found.ticker) });
  }
  const ticker = id;
  if (!Ticker.safeParse(ticker).success) return c.json({ error: "no such token" }, 404);
  const rec = await getTokenRecord(ticker);
  if (!rec) return c.json({ error: "no such token" }, 404);
  const s = parseCompact(rec.site);
  if (!s.colors) return c.json({ error: "token has no site config" }, 404);
  const siteConfig = SiteConfig.parse({
    siteId: `${ticker}-chain`,
    ownerWallet: rec.owner_id,
    ecosystem: "near",
    blueprint: "meme-landing",
    theme: { colors: s.colors, fonts: { heading: "Bowlby One", body: "Space Grotesk" } },
    branding: { name: ticker.toUpperCase(), ticker: ticker.toUpperCase(), tagline: s.tagline ?? "", description: s.description ?? "" },
    tokenLaunch: {
      contractOrMintAddress: rec.token_id,
      buyUrl: `${config.explorerBase}/token/${rec.token_id}`,
      explorerUrl: `${config.explorerBase}/address/${rec.token_id}`,
      launchedAt: Number(rec.created_at_ms),
    },
  });
  return c.json({ source: "chain", siteConfig, siteUrl: siteUrl(ticker) });
});

/** Creator settings for a token site. Owner-only: the session account must be the site's ownerWallet. */
app.put("/api/site/:id/settings", requireSession, requireAllowed, async (c) => {
  const id = c.req.param("id").toLowerCase();
  if (!SITE_ID_RE.test(id)) return c.json({ error: "invalid ticker or slug" }, 400);
  const body = SiteSettingsRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid settings", issues: body.error.issues }, 400);
  const found = await findSite(id);
  if (!found) return c.json({ error: "no such token site" }, 404);
  if (found.site.ownerWallet !== c.var.account) return c.json({ error: "only the token's creator can change its settings" }, 403);
  const gaId = body.data.gaId || undefined;
  const site = { ...found.site, analytics: gaId ? { ...found.site.analytics, gaId } : undefined };
  if (!gaId && site.analytics === undefined) delete (site as { analytics?: unknown }).analytics;
  await saveSite(found.ticker, site);
  return c.json({ ok: true, ticker: found.ticker, gaId: gaId ?? null });
});

const toLaunched = async (r: TokenRecord): Promise<LaunchedToken> => {
  const kv = await getSite(r.ticker);
  const s = parseCompact(r.site);
  return {
    ticker: r.ticker,
    tokenId: r.token_id,
    ownerId: r.owner_id,
    createdAt: Number(r.created_at_ms),
    name: kv?.branding.name ?? null,
    tagline: kv?.branding.tagline ?? s.tagline ?? null,
    colors: kv?.theme.colors ?? s.colors ?? null,
    slug: kv?.slug ?? null,
    views: await getViews(r.ticker),
    gaId: kv?.analytics?.gaId ?? null,
    siteUrl: siteUrl(kv?.slug ?? r.ticker),
    explorerUrl: `${config.explorerBase}/address/${r.token_id}`,
  };
};

/** "My launches": tokens owned by an account, newest first (public; on-chain data). */
app.get("/api/launches/:account", async (c) => {
  const account = NearAccountId.safeParse(c.req.param("account"));
  if (!account.success) return c.json({ error: "invalid account id" }, 400);
  const from = Number(c.req.query("from") ?? 0) || 0;
  const limit = Math.min(50, Number(c.req.query("limit") ?? 20) || 20);
  const recs = await getTokensByOwner(account.data, from, limit);
  return c.json({ account: account.data, launches: await Promise.all(recs.map(toLaunched)) });
});

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
  AdminAccountsRequest,
  formatNear,
  MAX_BATCH,
  MAX_RUN,
  type MeResponse,
  type WaitlistResponse,
  type GenerateResponse,
  type LaunchResponse,
  type Listing,
  IntentsQuoteRequest,
  IntentsPayoutRequest,
  isNearMainnetAccount,
  type IntentsSettings,
  TokensIntentsRequest,
  TokensLooftaRequest,
  LooftaCheckoutRequest,
  LooftaPayTo,
  type LooftaPageState,
  type LooftaSettings,
  type RheaOptions,
  JusthootFinalizeRequest,
  JusthootPrepareRequest,
  type JusthootFinalizeResponse,
  type JusthootPrepareResponse,
  NearlyFinalizeRequest,
  NearlyPrepareRequest,
  QuoteRequest,
  TokensActionRequest,
  type TokensActionResult,
  type NearlyFinalizeResponse,
  type NearlyLaunchTx,
  type NearlyPrepareResponse,
  type QuoteResponse,
  LlmKeyRequest,
  LlmModelsRequest,
  type LlmProviderInfo,
  type PlatformKeyInfo,
} from "@osl/schema";
import { buildListParams, computePoints, listingCost, poolIdFor, rheaPoolUrl } from "./rhea";
import { config } from "./config";
import { DEPOSIT_ADDRESS_RE, intentsForPage, intentsPageState, intentsPayKey, oneClickQuote, oneClickStatus, oneClickTokens, planQuote, shapeQuote, tipRecipient } from "./intents";
import { LLMCallError, envTarget, generateIdeas, type LLMTarget } from "./llm";
import {
  KEY_RATE_LIMIT,
  KeyError,
  MODELS_RATE_LIMIT,
  PLATFORM,
  PROVIDERS,
  PROVIDER_IDS,
  cleanKey,
  cleanModel,
  defaultModel,
  deleteRecord,
  keyStorageConfigured,
  last4,
  listModels,
  openKey,
  providerForBaseUrl,
  readRecord,
  sealKey,
  summarize,
  takeKeyRate,
  validateKey,
  writeRecord,
  type KeyRecord,
  type ProviderId,
} from "./llmkeys";
import { tokenIconDataUri } from "./icon";
import {
  accountExists,
  buildLaunchArgs,
  fitIcon,
  justhootLaunchesInTx,
  justhootProblem,
  justhootStatus,
  justhootTokenId,
  justhootUrl,
  quoteJusthoot,
  referenceJson,
  sha256Base64,
} from "./justhoot";
import {
  CHECKOUT_RATE_LIMIT,
  cleanLooftaKey,
  cleanMessage,
  createPaymentLink,
  deleteLooftaKey,
  deletePayTo,
  openLooftaKey,
  openPayTo,
  pageOwnerId,
  readLooftaKey,
  readPage as readLooftaPage,
  readPayTo,
  resolveRoute,
  sealLooftaKey,
  sealPayTo,
  sendUrl,
  summarizeLooftaKey,
  summarizePayTo,
  takeCheckoutRate,
  toPublic as looftaPublic,
  validateLooftaKey,
  writeLooftaKey,
  writePage as writeLooftaPage,
  writePayTo,
  type LooftaKeyRecord,
  type PageRecord as LooftaPageRecord,
} from "./loofta";
import { buildSiteConfig, claimSlug, compactSite, findSite, getIntents, getSite, getTakedown, setIntents, getViews, kvStore, putSite, restoreTakedown, saveSite, siteStoreKind, siteUrl, takeDown } from "./sites";
import {
  WAITLIST_MAX_BODY,
  addToWaitlist,
  approveAccounts,
  assertAdmin,
  assertAllowed,
  isAdmin,
  isWhitelisted,
  listAllowed,
  listWaitlist,
  removeAccounts,
  revokeAccounts,
  takeRateLimit,
} from "./gate";
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
  creatorDclStorageNeeded,
  ftBalanceOf,
  getDclPoolPoint,
  getHeld,
  listOnRhea,
  nearlyLaunchesInTx,
  quoteNearly,
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
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  }),
);

app.onError((err, c) => {
  if (err instanceof AuthError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status as 401 | 403);
  // Our own messages, never provider text or key material.
  if (err instanceof KeyError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
  if (err instanceof LLMCallError) {
    console.error(JSON.stringify({ llm_error: { source: err.source, status: err.status } }));
    return c.json({ error: err.message, code: "llm_failed" }, 502);
  }
  console.error(err);
  const msg = err instanceof Error ? err.message : String(err);
  const status = /insufficient balance/i.test(msg) ? 402 : 500;
  return c.json({ error: msg }, status);
});

app.get("/", (c) => c.json({ ok: true, service: "yeetpad orchestrator", network: config.networkId }));
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    network: config.networkId,
    llmMock: config.llmMock,
    nearMock: config.nearMock,
    model: config.nearAiModel,
    vault: config.vaultContract,
    factory: config.factoryContract,
    aiComputeCost: config.aiComputeCostYocto,
    maxBatch: MAX_BATCH,
    maxRun: MAX_RUN,
    venues: {
      rhea: { dcl: config.dclContract, wnear: config.wnearContract, defaultFdvNear: config.rheaDefaultFdvNear },
      nearly: { factory: config.nearlyFactory, chunk: config.nearlyBatchChunk, enabled: config.nearlyEnabled, reason: config.nearlyEnabled ? null : config.nearlyDisabledReason },
      // Flag only (no RPC); /api/justhoot/status adds is_public_launch.
      justhoot: { factory: config.justhootFactory, chunk: config.justhootBatchChunk, enabled: config.justhootEnabled, reason: config.justhootEnabled ? null : config.justhootDisabledReason },
    },
    siteStore: siteStoreKind(),
    siteBase: config.siteBase,
    locked: config.locked,
    byok: keyStorageConfigured(),
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
  await assertAllowed(accountId, config, kvStore());
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
  await assertAllowed(c.var.account, config, kvStore());
  await next();
});

/** Admins only (ADMIN_ACCOUNTS); 403 `not_admin` otherwise. */
const requireAdmin = createMiddleware<Env>(async (c, next) => {
  assertAdmin(c.var.account, config);
  await next();
});

app.get("/api/auth/me", requireSession, async (c) => {
  const res: MeResponse = {
    accountId: c.var.account,
    isAdmin: isAdmin(c.var.account, config),
    whitelisted: await isWhitelisted(c.var.account, config, kvStore()),
    locked: config.locked,
  };
  return c.json(res);
});

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
  const avoid = body.data.avoid ?? [];

  // The caller's own key: their provider bills them, so no AI fee. Never falls back to the platform key on its own.
  const own = body.data.usePlatformKey ? null : await readRecord(kvStore(), ownerWallet);
  if (own) {
    const label = PROVIDERS[own.provider].label;
    const fallback = { code: "user_key_invalid", provider: own.provider, fallbackCost: cost.toString() };
    if (!own.valid) {
      return c.json({ error: `Your ${label} key isn't working${own.lastError ? `: ${own.lastError}` : ""}. Replace it in AI key settings, or use the platform key (${formatNear(cost)} NEAR). Nothing was charged.`, ...fallback }, 424);
    }
    const apiKey = await openKey(ownerWallet, own).catch(() => null);
    if (!apiKey) return c.json({ error: `Your saved ${label} key can't be read; replace it in AI key settings. Nothing was charged.`, ...fallback }, 424);
    const target: LLMTarget = { baseUrl: PROVIDERS[own.provider].baseUrl, apiKey, model: own.model, source: "user", provider: own.provider };
    let ideas;
    try {
      ideas = await generateIdeas(prompt, count, avoid, body.data.seq, target);
    } catch (e) {
      if (!(e instanceof LLMCallError)) throw e;
      if (e.status === 401 || e.status === 403 || e.status === 402 || e.status === 429) {
        // Remember auth failures so the next request explains at once; quota errors only leave a note.
        const bad = e.status === 401 || e.status === 403;
        await writeRecord(kvStore(), ownerWallet, { ...own, valid: bad ? false : own.valid, lastError: e.message, validatedAt: bad ? Date.now() : own.validatedAt });
      }
      return c.json({ error: `${e.message} Nothing was charged.`, ...fallback, code: "user_key_failed", status: e.status }, 424);
    }
    const res: GenerateResponse = { idea: ideas[0], ideas, charged: "0", txHash: null, keySource: "user", provider: own.provider, model: own.model };
    return c.json(res);
  }

  const bal = await getVaultBalance(ownerWallet);
  if (bal < cost) {
    return c.json({ error: `insufficient vault balance: need ${formatNear(cost)} NEAR for ${count} idea(s), have ${formatNear(bal)}` }, 402);
  }

  const target = config.llmMock ? undefined : await platformTarget();
  const ideas = await generateIdeas(prompt, count, avoid, body.data.seq, target);
  // Charge only after valid ideas were produced (one charge for the whole set).
  const txHash = cost > 0n ? await deductAiCompute(ownerWallet, cost) : null;
  const res: GenerateResponse = { idea: ideas[0], ideas, charged: cost.toString(), txHash, keySource: target?.source ?? "env", provider: target?.provider ?? null, model: target?.model ?? config.nearAiModel };
  return c.json(res);
});

/** Platform LLM: the admin-set stored key when present and valid, else the NEARAI_* env fallback. */
async function platformTarget(): Promise<LLMTarget> {
  const rec = await readRecord(kvStore(), PLATFORM).catch(() => null);
  if (rec?.valid) {
    const apiKey = await openKey(PLATFORM, rec).catch(() => null);
    if (apiKey) return { baseUrl: PROVIDERS[rec.provider].baseUrl, apiKey, model: rec.model, source: "platform", provider: rec.provider };
  }
  return envTarget();
}

app.post("/api/launch", requireSession, requireAllowed, async (c) => {
  const body = LaunchRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const { idea } = body.data;
  const ownerWallet = ownerFor(c, body.data.ownerWallet);
  const tokenAccount = `${idea.ticker}.${config.factoryContract}`;

  if (await isTickerTaken(idea.ticker)) {
    return c.json({ error: `ticker "${idea.ticker}" is taken (${tokenAccount}); edit it and retry` }, 409);
  }
  const rhea = body.data.listOn === "rhea";
  const deposit = await getRequiredLaunchDeposit();
  const listFee = rhea ? listingCost(await creatorDclStorageNeeded(ownerWallet)) : 0n;
  const bal = await getVaultBalance(ownerWallet);
  if (bal < deposit + listFee) {
    return c.json({ error: `insufficient vault balance: launch${rhea ? " + Rhea listing" : ""} needs ~${formatNear(deposit + listFee)} NEAR, have ${formatNear(bal)}` }, 402);
  }

  const icon = tokenIconDataUri(idea);
  const { tokenId, txHash } = await executeSponsoredLaunch(ownerWallet, tokenArgs(idea, icon, rhea), deposit);
  if (!tokenId) {
    return c.json({ error: "launch failed on-chain; your balance was refunded", txHash, explorerUrl: `${config.explorerBase}/txns/${txHash}` }, 502);
  }

  const listing = rhea ? await listRhea(ownerWallet, tokenId, body.data.rhea) : null;
  const siteConfig = await putSite(withBuyUrl(buildSiteConfig(ownerWallet, idea, tokenId, { txHash, icon }), listing));
  const res: LaunchResponse = {
    tokenId,
    txHash,
    explorerUrl: `${config.explorerBase}/txns/${txHash}`,
    siteConfig,
    siteUrl: siteUrl(siteConfig.slug ?? idea.ticker),
    listing,
  };
  return c.json(res);
});

/** Lists a held token on Rhea DCL via the vault and records it (KV `listing:<ticker>`). */
async function listRhea(owner: string, tokenId: string, opts: RheaOptions | undefined): Promise<Listing> {
  const ticker = tokenId.split(".")[0];
  try {
    // What the vault actually holds for this token (full supply for a fresh launch).
    const held = await ftBalanceOf(tokenId, config.vaultContract);
    if (held === 0n) throw new Error("the vault holds none of this token");
    const params = buildListParams({
      tokenId,
      supply: BigInt(config.tokenTotalSupply),
      holding: held,
      decimals: config.tokenDecimals,
      fdvNear: opts?.openingFdvNear ?? config.rheaDefaultFdvNear,
      creatorPct: opts?.creatorPct ?? 0,
      creatorDclStorage: await creatorDclStorageNeeded(owner),
      existingPoint: await getDclPoolPoint(poolIdFor(tokenId)),
    });
    const { tokenIsX: _x, ...args } = params;
    const r = await listOnRhea(owner, tokenId, args);
    const listing: Listing = {
      venue: "rhea",
      ok: r.ok,
      tokenId,
      poolId: r.poolId,
      lptId: r.lptId,
      url: r.poolId ? rheaPoolUrl(r.poolId) : null,
      txHash: r.txHash,
      error: r.ok ? null : `listing failed at ${r.failedStep ?? "hand-off"}; ${r.positionToCreator ? "" : "tokens were sent to your wallet"}`.trim(),
    };
    await kvStore().put(`listing:${ticker}`, JSON.stringify(listing));
    return listing;
  } catch (e) {
    const listing: Listing = { venue: "rhea", ok: false, tokenId, poolId: null, lptId: null, url: null, txHash: null, error: `listing not started: ${(e as Error).message}` };
    await kvStore().put(`listing:${ticker}`, JSON.stringify(listing));
    return listing;
  }
}

function withBuyUrl<T extends import("@osl/schema").SiteConfig>(site: T, listing: Listing | null): T {
  if (!listing?.ok || !listing.url) return site;
  return { ...site, tokenLaunch: { ...site.tokenLaunch, buyUrl: listing.url } };
}

function tokenArgs(idea: import("@osl/schema").LaunchIdea, icon: string, hold = false): TokenArgs {
  return {
    ...(hold ? { hold_for_listing: true } : {}),
    ticker: idea.ticker,
    name: idea.name,
    symbol: idea.ticker.toUpperCase(),
    icon,
    decimals: config.tokenDecimals,
    total_supply: config.tokenTotalSupply,
    site: compactSite(idea),
  };
}

/**
 * List an existing Yeetpad token on Rhea. The creator first sends the tokens to the vault with
 * `ft_transfer_call(vault, amount, "list_on_rhea")` (the vault then holds them for this account).
 */
app.post("/api/list/rhea", requireSession, requireAllowed, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { tokenId?: string; rhea?: RheaOptions } | null;
  const tokenId = body?.tokenId ?? "";
  if (!tokenId.endsWith(`.${config.factoryContract}`)) return c.json({ error: "not a Yeetpad token" }, 400);
  const held = await getHeld(tokenId);
  if (!held || held.creator !== c.var.account) return c.json({ error: "send the tokens to the vault with msg list_on_rhea first" }, 409);
  if (held.listing) return c.json({ error: "listing already in progress" }, 409);
  const exists = (await getDclPoolPoint(poolIdFor(tokenId))) !== null;
  const cost = listingCost(await creatorDclStorageNeeded(c.var.account), exists);
  const bal = await getVaultBalance(c.var.account);
  if (bal < cost) return c.json({ error: `insufficient vault balance: listing needs ~${formatNear(cost)} NEAR, have ${formatNear(bal)}` }, 402);
  const listing = await listRhea(c.var.account, tokenId, body?.rhea);
  const ticker = tokenId.split(".")[0];
  const found = await findSite(ticker);
  if (found && listing.ok) await saveSite(found.ticker, withBuyUrl(found.site, listing));
  return c.json({ listing }, listing.ok ? 200 : 502);
});

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

  const rhea = body.data.listOn === "rhea";
  const deposit = await getRequiredLaunchDeposit();
  // First listing may register the creator on DCL (0.5); later ones in the batch don't.
  const firstList = rhea ? listingCost(await creatorDclStorageNeeded(ownerWallet)) : 0n;
  const nextList = rhea ? listingCost(0n) : 0n;
  const need = deposit * BigInt(ideas.length) + (rhea ? firstList + nextList * BigInt(ideas.length - 1) : 0n);
  const bal = await getVaultBalance(ownerWallet);
  if (bal < need) {
    return c.json({ error: `insufficient vault balance: ${ideas.length} launch(es)${rhea ? " + Rhea listings" : ""} need ~${formatNear(need)} NEAR, have ${formatNear(bal)}` }, 402);
  }

  const icons = ideas.map((i) => tokenIconDataUri(i));
  const { txHash, results } = await executeSponsoredLaunchBatch(
    ownerWallet,
    ideas.map((idea, i) => tokenArgs(idea, icons[i], rhea)),
    deposit,
  );
  const out: BatchLaunchResponse["results"] = [];
  for (const [i, r] of results.entries()) {
    if (r.tokenId) {
      // One listing tx per token, sequential (each needs ~300 Tgas).
      const listing = rhea ? await listRhea(ownerWallet, r.tokenId, body.data.rhea) : null;
      const site = await putSite(withBuyUrl(buildSiteConfig(ownerWallet, ideas[i], r.tokenId, { txHash, icon: icons[i] }), listing));
      out.push({ ticker: r.ticker, ok: true, tokenId: r.tokenId, slug: site.slug ?? null, siteUrl: siteUrl(site.slug ?? r.ticker), error: null, listing });
    } else {
      out.push({ ticker: r.ticker, ok: false, tokenId: null, slug: null, siteUrl: null, error: "launch failed on-chain; that item was refunded" });
    }
  }
  const res: BatchLaunchResponse = { txHash, explorerUrl: `${config.explorerBase}/txns/${txHash}`, results: out };
  return c.json(res, out.some((r) => r.ok) ? 200 : 502);
});

// ---------- venue quotes ----------
const NEARLY_GAS = (300n * 10n ** 12n).toString();
const nearlyText = (idea: import("@osl/schema").LaunchIdea, website: string) =>
  new TextEncoder().encode(idea.name + idea.ticker + idea.description + website).length;

/** Estimated cost per token for a venue (from on-chain quote views) and the total. */
app.post("/api/quote", requireSession, async (c) => {
  const body = QuoteRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const { ideas, listOn } = body.data;
  const notes: string[] = [];
  const items: QuoteResponse["items"] = [];
  let total = 0n;
  let rheaInfo: QuoteResponse["rhea"];
  if (listOn === "justhoot") {
    const st = await justhootStatus(c.var.account);
    if (!st.enabled) return c.json({ error: st.reason, code: "venue_disabled" }, 503);
    for (const idea of ideas) {
      const bad = justhootProblem(idea);
      if (bad) return c.json({ error: bad }, 400);
      const website = siteUrl(await claimSlug(idea.name, idea.ticker));
      const icon = fitIcon([body.data.icons?.[idea.ticker], tokenIconDataUri(idea)]);
      const ref = config.justhootReference ? { url: justhootRefUrl(idea.ticker), hash: await sha256Base64(referenceJson(idea, website)) } : null;
      const q = await quoteJusthoot(buildLaunchArgs(idea, icon, ref), c.var.account);
      total += BigInt(q.deposit);
      items.push({ ticker: idea.ticker, total: q.deposit, paidFrom: "wallet", parts: { launch_deposit: q.deposit, ...(icon ? {} : { no_icon: "0" }) } });
    }
    notes.push(
      `JustHoot (${config.justhootFactory}) creates the token and its Rhea pool; your wallet signs and pays the exact get_launch_deposit (unused part refunded). JustHoot's pool creator holds the LP; you are the token's fee recipient.`,
      `Description and socials show on your Yeetpad site page (${config.siteBase}/t/<slug>), linked as the token's on-chain reference; JustHoot's own socials form isn't used.`,
    );
  } else if (listOn === "nearly") {
    if (!config.nearlyEnabled) return c.json({ error: config.nearlyDisabledReason, code: "venue_disabled" }, 503);
    for (const idea of ideas) {
      const icon = tokenIconDataUri(idea);
      const website = siteUrl(await claimSlug(idea.name, idea.ticker));
      const q = await quoteNearly(new TextEncoder().encode(icon).length, nearlyText(idea, website));
      const t = BigInt(q.total);
      total += t;
      items.push({ ticker: idea.ticker, total: q.total, paidFrom: "wallet", parts: { token_storage: q.token_storage, pool_create: q.pool_create, dcl_storage: q.dcl_storage } });
    }
    notes.push(`Nearly (${config.nearlyFactory}) creates and lists the token; your wallet signs and pays. Nearly locks the LP and takes its own trading fees.`);
  } else {
    const deposit = await getRequiredLaunchDeposit();
    const dclFirst = listOn === "rhea" ? await creatorDclStorageNeeded(c.var.account) : 0n;
    ideas.forEach((idea, i) => {
      const parts: Record<string, string> = { token_account: deposit.toString() };
      let t = deposit;
      if (listOn === "rhea") {
        const dcl = i === 0 ? dclFirst : 0n;
        parts.pool_create = config.rheaPoolDepositYocto;
        parts.registrations = (2n * 1_250_000_000_000_000_000_000n).toString();
        if (dcl > 0n) parts.dcl_storage_first_time = dcl.toString();
        t += listingCost(dcl);
      }
      total += t;
      items.push({ ticker: idea.ticker, total: t.toString(), paidFrom: "credit", parts });
    });
    if (listOn === "rhea") {
      const fdv = body.data.rhea?.openingFdvNear ?? config.rheaDefaultFdvNear;
      const pct = body.data.rhea?.creatorPct ?? 0;
      const pts = computePoints(`${ideas[0].ticker}.${config.factoryContract}`, config.wnearContract, fdv, BigInt(config.tokenTotalSupply), config.tokenDecimals);
      rheaInfo = { openingFdvNear: fdv, creatorPct: pct, initPoint: pts.init };
      if (dclFirst > 0n) notes.push(`First Rhea listing registers you on Rhea DCL (${formatNear(dclFirst)} NEAR storage, yours, withdrawable from Rhea).`);
      notes.push("Rhea refunds unused pool-creation NEAR to the vault (~0.01 of the 0.02).");
    }
  }
  const res: QuoteResponse = { listOn, items, total: total.toString(), notes, ...(rheaInfo ? { rhea: rheaInfo } : {}) };
  return c.json(res);
});

// ---------- Nearly (creator's wallet signs) ----------
const pendingKey = (ticker: string) => `nearly-pending:${ticker}`;
const nearlyUrl = (tokenId: string) =>
  config.nearlyTokenUrlBase ? `${config.nearlyTokenUrlBase}${tokenId}` : `${config.explorerBase}/address/${tokenId}`;

/** Builds the `launch` calls for the creator's wallet; reserves slugs so the site link is known up front. */
app.post("/api/nearly/prepare", requireSession, requireAllowed, async (c) => {
  if (!config.nearlyEnabled) return c.json({ error: config.nearlyDisabledReason, code: "venue_disabled" }, 503);
  const body = NearlyPrepareRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const owner = c.var.account;
  const kv = kvStore();
  const txs: NearlyLaunchTx[] = [];
  let total = 0n;
  for (const idea of body.data.ideas) {
    const existing = await findSite(idea.ticker);
    if ((existing && existing.site.ownerWallet !== owner) || (await isTickerTaken(idea.ticker))) {
      return c.json({ error: `ticker "${idea.ticker}" is taken on Yeetpad; edit it and retry` }, 409);
    }
    const icon = tokenIconDataUri(idea);
    const iconBytes = new TextEncoder().encode(icon).length;
    if (iconBytes > 16_384) return c.json({ error: `icon for ${idea.ticker} is ${iconBytes} bytes (Nearly max 16384)` }, 400);
    const slug = await claimSlug(idea.name, idea.ticker);
    await kv.put(`slug:${slug}`, idea.ticker);
    await kv.put(pendingKey(idea.ticker), JSON.stringify({ owner, idea, icon, slug, at: Date.now() }));
    const website = siteUrl(slug);
    const q = await quoteNearly(iconBytes, nearlyText(idea, website));
    total += BigInt(q.total);
    txs.push({
      ticker: idea.ticker,
      slug,
      receiverId: config.nearlyFactory,
      methodName: "launch",
      args: {
        args: {
          name: idea.name,
          symbol: idea.ticker.toUpperCase(),
          icon,
          description: `${idea.tagline} ${idea.description}`.slice(0, 600),
          links: { website, twitter: null, telegram: null },
          dev_buy: "0",
        },
      },
      gas: NEARLY_GAS,
      deposit: q.total,
    });
  }
  const res: NearlyPrepareResponse = { factory: config.nearlyFactory, chunk: config.nearlyBatchChunk, txs, total: total.toString() };
  return c.json(res);
});

/** After the wallet signed: verifies each tx on chain, then writes the site + listing records. */
app.post("/api/nearly/finalize", requireSession, requireAllowed, async (c) => {
  const body = NearlyFinalizeRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const owner = c.var.account;
  const kv = kvStore();
  const results: NearlyFinalizeResponse["results"] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof nearlyLaunchesInTx>>>();
  for (const { ticker, txHash } of body.data.items) {
    const fail = (error: string) => results.push({ ticker, ok: false, tokenId: null, slug: null, siteUrl: null, error, listing: null });
    const raw = await kv.get(pendingKey(ticker));
    if (!raw) {
      fail("no pending Nearly launch for this ticker (prepare first)");
      continue;
    }
    const p = JSON.parse(raw) as { owner: string; idea: import("@osl/schema").LaunchIdea; icon: string; slug: string };
    if (p.owner !== owner) {
      fail("prepared by another account");
      continue;
    }
    let evs = cache.get(txHash);
    if (!evs) {
      evs = await nearlyLaunchesInTx(txHash, owner).catch(() => []);
      cache.set(txHash, evs);
    }
    const ev = evs.find((e) => e.creator === owner && e.symbol === ticker.toUpperCase());
    if (!ev) {
      fail("no matching Nearly launch in that transaction");
      continue;
    }
    const listing: Listing = { venue: "nearly", ok: true, tokenId: ev.token, poolId: ev.pool_id ?? null, lptId: ev.lpt_id ?? null, url: nearlyUrl(ev.token), txHash, error: null };
    const base = buildSiteConfig(owner, p.idea, ev.token, { txHash, icon: p.icon });
    const site = await putSite({ ...base, slug: p.slug, tokenLaunch: { ...base.tokenLaunch, buyUrl: listing.url! } });
    await kv.put(`listing:${ticker}`, JSON.stringify(listing));
    await addVenueIndex(owner, "nearly", ticker, ev.token);
    await kv.delete?.(pendingKey(ticker));
    results.push({ ticker, ok: true, tokenId: ev.token, slug: site.slug ?? null, siteUrl: siteUrl(site.slug ?? ticker), error: null, listing });
  }
  return c.json({ results } satisfies NearlyFinalizeResponse, results.some((r) => r.ok) ? 200 : 400);
});

// ---------- JustHoot (creator's wallet signs launch_meme; mainnet only) ----------
const jhPendingKey = (ticker: string) => `justhoot-pending:${ticker}`;
const jhRefKey = (ticker: string) => `justhoot-ref:${ticker}`;
const justhootRefUrl = (ticker: string) => `${config.publicApiBase}/api/justhoot/ref/${ticker}.json`;

app.get("/api/justhoot/status", async (c) => {
  const acct = NearAccountId.safeParse(c.req.query("account") ?? "");
  return c.json({ factory: config.justhootFactory, chunk: config.justhootBatchChunk, ...(await justhootStatus(acct.success ? acct.data : null)) });
});

/** Token metadata JSON linked from launch_meme's `reference` (exact bytes that were hashed). */
app.get("/api/justhoot/ref/:file", async (c) => {
  const t = Ticker.safeParse(c.req.param("file").replace(/\.json$/, ""));
  if (!t.success) return c.json({ error: "not found" }, 404);
  const body = await kvStore().get(jhRefKey(t.data));
  if (!body) return c.json({ error: "not found" }, 404);
  return c.body(body, 200, { "content-type": "application/json", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" });
});

app.post("/api/justhoot/prepare", requireSession, requireAllowed, async (c) => {
  const owner = c.var.account;
  const st = await justhootStatus(owner);
  if (!st.enabled) return c.json({ error: st.reason, code: "venue_disabled" }, 503);
  const body = JusthootPrepareRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const kv = kvStore();
  const txs: NearlyLaunchTx[] = [];
  let total = 0n;
  for (const idea of body.data.ideas) {
    const bad = justhootProblem(idea);
    if (bad) return c.json({ error: bad }, 400);
    const existing = await findSite(idea.ticker);
    if ((existing && existing.site.ownerWallet !== owner) || (await isTickerTaken(idea.ticker))) {
      return c.json({ error: `ticker "${idea.ticker}" is taken on Yeetpad; edit it and retry` }, 409);
    }
    const tokenId = justhootTokenId(idea.ticker);
    if (await accountExists(tokenId)) return c.json({ error: `ticker "${idea.ticker}" is taken on JustHoot (${tokenId}); edit it and retry` }, 409);
    const icon = fitIcon([body.data.icons?.[idea.ticker], tokenIconDataUri(idea)]);
    const slug = await claimSlug(idea.name, idea.ticker);
    await kv.put(`slug:${slug}`, idea.ticker);
    let ref: { url: string; hash: string } | null = null;
    if (config.justhootReference) {
      const json = referenceJson(idea, siteUrl(slug));
      await kv.put(jhRefKey(idea.ticker), json);
      ref = { url: justhootRefUrl(idea.ticker), hash: await sha256Base64(json) };
    }
    const args = buildLaunchArgs(idea, icon, ref);
    const q = await quoteJusthoot(args, owner);
    await kv.put(jhPendingKey(idea.ticker), JSON.stringify({ owner, idea, icon: icon ?? tokenIconDataUri(idea), slug, tokenId, at: Date.now() }));
    total += BigInt(q.deposit);
    txs.push({ ticker: idea.ticker, slug, receiverId: config.justhootFactory, methodName: "launch_meme", args: { args }, gas: q.gas, deposit: q.deposit });
  }
  const res: JusthootPrepareResponse = { factory: config.justhootFactory, chunk: config.justhootBatchChunk, txs, total: total.toString() };
  return c.json(res);
});

app.post("/api/justhoot/finalize", requireSession, requireAllowed, async (c) => {
  const body = JusthootFinalizeRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const owner = c.var.account;
  const kv = kvStore();
  const results: JusthootFinalizeResponse["results"] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof justhootLaunchesInTx>>>();
  for (const { ticker, txHash } of body.data.items) {
    const fail = (error: string) => results.push({ ticker, ok: false, tokenId: null, slug: null, siteUrl: null, error, listing: null });
    const raw = await kv.get(jhPendingKey(ticker));
    if (!raw) {
      fail("no pending JustHoot launch for this ticker (prepare first)");
      continue;
    }
    const p = JSON.parse(raw) as { owner: string; idea: import("@osl/schema").LaunchIdea; icon: string; slug: string; tokenId: string };
    if (p.owner !== owner) {
      fail("prepared by another account");
      continue;
    }
    let r = cache.get(txHash);
    if (!r) {
      r = await justhootLaunchesInTx(txHash, owner).catch((e) => ({ launched: [], failures: [`couldn't read the transaction (${(e as Error).message.slice(0, 80)})`] }));
      cache.set(txHash, r);
    }
    const ev = r.launched.find((e) => e.creator_id === owner && e.token_id === p.tokenId);
    if (!ev) {
      fail(r.failures[0] ?? "no matching JustHoot launch in that transaction");
      continue;
    }
    const listing: Listing = { venue: "justhoot", ok: true, tokenId: ev.token_id, poolId: `${ev.token_id}|wrap.near|10000`, lptId: null, url: justhootUrl(ev.token_id), txHash, error: null };
    const base = buildSiteConfig(owner, p.idea, ev.token_id, { txHash, icon: p.icon });
    const site = await putSite({ ...base, slug: p.slug, tokenLaunch: { ...base.tokenLaunch, buyUrl: listing.url! } });
    await kv.put(`listing:${ticker}`, JSON.stringify(listing));
    await addVenueIndex(owner, "justhoot", ticker, ev.token_id);
    await kv.delete?.(jhPendingKey(ticker));
    results.push({ ticker, ok: true, tokenId: ev.token_id, slug: site.slug ?? null, siteUrl: siteUrl(site.slug ?? ticker), error: null, listing });
  }
  return c.json({ results } satisfies JusthootFinalizeResponse, results.some((r) => r.ok) ? 200 : 400);
});

/** Tokens made by an outside venue's factory are indexed in KV (`<venue>-by:<owner>`) for My launches. */
async function addVenueIndex(owner: string, venue: "nearly" | "justhoot", ticker: string, tokenId: string) {
  const kv = kvStore();
  const key = `${venue}-by:${owner}`;
  const idx = JSON.parse((await kv.get(key)) ?? "[]") as { ticker: string; tokenId: string; at: number }[];
  if (!idx.some((x) => x.tokenId === tokenId)) idx.unshift({ ticker, tokenId, at: Date.now() });
  await kv.put(key, JSON.stringify(idx.slice(0, 500)));
}

// ---------- take down / restore a token's site (creator, or an admin for moderation) ----------
/** Who may act on `ticker`: its recorded creator (factory registry, else the site's ownerWallet) or an admin. */
async function tokenAccess(ticker: string, account: string): Promise<{ ok: true; admin: boolean; creator?: string } | { ok: false; status: 403 | 404; note: string }> {
  const rec = await getTokenRecord(ticker).catch(() => null);
  const creator = rec?.owner_id ?? (await findSite(ticker))?.site.ownerWallet ?? null;
  const admin = isAdmin(account, config);
  if (!creator) return admin ? { ok: true, admin } : { ok: false, status: 404, note: "no such token" };
  if (creator === account) return { ok: true, admin: false, creator };
  if (admin) return { ok: true, admin: true, creator };
  return { ok: false, status: 403, note: "only the token's creator can do this" };
}

async function tokensAction(c: import("hono").Context<Env>, kind: "delete" | "restore") {
  const body = TokensActionRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const account = c.var.account;
  const results: TokensActionResult[] = [];
  let forbidden = 0;
  for (const ticker of [...new Set(body.data.tokens)]) {
    const a = await tokenAccess(ticker, account);
    if (!a.ok) {
      if (a.status === 403) forbidden++;
      results.push({ ticker, ok: false, note: a.note });
      continue;
    }
    const td = await getTakedown(ticker);
    if (kind === "delete") {
      if (td) results.push({ ticker, ok: true, note: "already taken down" });
      else {
        await takeDown(ticker, { at: Date.now(), by: account, ...(a.admin ? { byAdmin: true } : {}) });
        results.push({ ticker, ok: true });
      }
    } else if (!td) results.push({ ticker, ok: true, note: "not taken down" });
    else if (td.byAdmin && !isAdmin(account, config)) {
      forbidden++;
      results.push({ ticker, ok: false, note: "taken down by a moderator; only an admin can restore it" });
    } else {
      await restoreTakedown(ticker);
      results.push({ ticker, ok: true });
    }
  }
  const status = results.some((r) => r.ok) ? 200 : forbidden ? 403 : 404;
  return c.json({ results, ...(status !== 200 ? { error: results[0]?.note ?? "nothing changed" } : {}) }, status);
}

/** Soft-deletes Yeetpad sites (deleted:<ticker> + site.takenDown); the on-chain token is untouched. */
app.post("/api/tokens/delete", requireSession, requireAllowed, (c) => tokensAction(c, "delete"));
app.post("/api/tokens/restore", requireSession, requireAllowed, (c) => tokensAction(c, "restore"));

/** Turns the NEAR Intents widget on/off (and sets its mode) for many token pages at once. Creator or admin. */
app.post("/api/tokens/intents", requireSession, requireAllowed, async (c) => {
  const body = TokensIntentsRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid request", issues: body.error.issues }, 400);
  const { tokens, intents } = body.data;
  // NEAR Intents is mainnet-only on every deployment: a tip recipient must be able to receive on mainnet.
  if (intents.recipient && !isNearMainnetAccount(intents.recipient))
    return c.json({ error: "tips settle on NEAR mainnet: the recipient must be a mainnet account (name.near or an implicit account)" }, 400);
  const results: TokensActionResult[] = [];
  let forbidden = 0;
  for (const ticker of [...new Set(tokens)]) {
    const a = await tokenAccess(ticker, c.var.account);
    if (!a.ok) {
      if (a.status === 403) forbidden++;
      results.push({ ticker, ok: false, note: a.note });
      continue;
    }
    await setIntents(ticker, intents);
    results.push({ ticker, ok: true });
  }
  const status = results.some((r) => r.ok) ? 200 : forbidden ? 403 : 404;
  return c.json({ results, ...(status !== 200 ? { error: results[0]?.note ?? "nothing changed" } : {}) }, status);
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

// ---------- admin (session + ADMIN_ACCOUNTS) ----------
app.use("/api/admin/*", requireSession, requireAdmin);

/** Waitlist requests with effective status (approved = on the allowlist now). Follows KV list cursors. */
app.get("/api/admin/waitlist", async (c) => {
  const { entries, allowed, truncated } = await listWaitlist(kvStore(), config);
  const counts = { total: entries.length, pending: 0, approved: 0, revoked: 0 };
  for (const e of entries) counts[e.status]++;
  return c.json({ entries, counts, allowed, truncated });
});

/** Everyone who can get in: admins, ALLOWED_ACCOUNTS and KV approvals. */
app.get("/api/admin/allowed", async (c) => c.json(await listAllowed(kvStore(), config)));

const adminBody = async (c: { req: { json(): Promise<unknown> } }) => AdminAccountsRequest.safeParse(await c.req.json().catch(() => null));

/** Bulk approve: writes allow:<account> {approvedAt, approvedBy}; takes effect within ~30 s. */
app.post("/api/admin/approve", async (c) => {
  const body = await adminBody(c);
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid request", issues: body.error.issues }, 400);
  return c.json({ results: await approveAccounts(kvStore(), body.data.accounts, c.var.account) });
});

/** Bulk revoke: deletes allow:<account>, keeps the waitlist request (status revoked). */
app.post("/api/admin/revoke", async (c) => {
  const body = await adminBody(c);
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid request", issues: body.error.issues }, 400);
  return c.json({ results: await revokeAccounts(kvStore(), body.data.accounts, config) });
});

/** Bulk remove: revokes access and deletes the waitlist request. */
app.post("/api/admin/remove", async (c) => {
  const body = await adminBody(c);
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid request", issues: body.error.issues }, 400);
  return c.json({ results: await removeAccounts(kvStore(), body.data.accounts, config) });
});

// ---------- AI keys: bring your own key (user) + platform default key (admin) ----------
// Keys are write-only: these routes return provider, model, last 4 characters, dates and validity, never the key.

const providerInfo = (): LlmProviderInfo[] =>
  PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label, baseUrl: PROVIDERS[id].baseUrl, keysUrl: PROVIDERS[id].keysUrl, defaultModels: [...PROVIDERS[id].preferredModels] }));

app.get("/api/llm/providers", (c) => c.json({ providers: providerInfo(), aiComputeCost: config.aiComputeCostYocto, enabled: keyStorageConfigured() }));

async function parseKeyBody<T>(c: import("hono").Context<Env>, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } } }): Promise<T> {
  const text = await c.req.text().catch(() => "");
  if (text.length > 8192) throw new KeyError("request too large", 400);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (json && typeof json === "object" && ("baseUrl" in json || "baseURL" in json || "url" in json)) {
    throw new KeyError(`custom base URLs aren't allowed; pick one of: ${PROVIDER_IDS.join(", ")}`, 400, "url_not_allowed");
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    // Never echo input values (they may contain the key).
    const msg = i?.path?.[0] === "provider" ? `provider must be one of: ${PROVIDER_IDS.join(", ")}` : `invalid ${String(i?.path?.[0] ?? "request")}`;
    throw new KeyError(msg, 400);
  }
  return r.data;
}

async function rate(account: string, bucket: "save" | "models") {
  const limit = bucket === "save" ? KEY_RATE_LIMIT : MODELS_RATE_LIMIT;
  if (!(await takeKeyRate(kvStore(), account, bucket, limit))) {
    throw new KeyError(`too many ${bucket === "save" ? "key saves/tests" : "model list requests"}; limit is ${limit} per hour`, 429, "rate_limited");
  }
}

const requireKeyStorage = () => {
  if (!keyStorageConfigured()) throw new KeyError("saving AI keys isn't enabled on this server yet", 503, "key_storage_unconfigured");
};

/** The key to use for a models/save request: the pasted one, else the stored one for the same provider. */
async function keyFor(owner: string, provider: ProviderId, pasted: string | undefined, existing: KeyRecord | null): Promise<string> {
  if (pasted !== undefined && pasted.trim() !== "") return cleanKey(pasted);
  if (existing && existing.provider === provider) return openKey(owner, existing);
  throw new KeyError(`paste your ${PROVIDERS[provider].label} API key first`, 400, "key_required");
}

async function modelsFor(owner: string, c: import("hono").Context<Env>, actor: string) {
  requireKeyStorage();
  const body = await parseKeyBody(c, LlmModelsRequest);
  await rate(actor, "models");
  const existing = await readRecord(kvStore(), owner);
  const apiKey = await keyFor(owner, body.provider, body.apiKey, existing);
  const models = await listModels(body.provider, apiKey);
  return c.json({ provider: body.provider, models, defaultModel: defaultModel(body.provider, models) });
}

/** Validate (cheap authenticated call) and store encrypted. Nothing is stored if validation fails. */
async function saveKeyFor(owner: string, c: import("hono").Context<Env>, actor: string) {
  requireKeyStorage();
  const body = await parseKeyBody(c, LlmKeyRequest);
  await rate(actor, "save");
  const kv = kvStore();
  const existing = await readRecord(kv, owner);
  const replacing = body.apiKey !== undefined && body.apiKey.trim() !== "";
  const apiKey = await keyFor(owner, body.provider, body.apiKey, existing);
  const models = await listModels(body.provider, apiKey);
  const model = body.model ? cleanModel(body.model) : defaultModel(body.provider, models);
  if (!model) throw new KeyError(`${PROVIDERS[body.provider].label} returned no models`, 502);
  if (models.length && !models.some((m) => m.id === model)) throw new KeyError(`${PROVIDERS[body.provider].label} doesn't offer model "${model}"`, 400, "unknown_model");
  const v = await validateKey(body.provider, apiKey, model);
  if (!v.ok) throw new KeyError(`${v.error} The key was not saved.`, 400, "key_invalid");
  const now = Date.now();
  const sealed = await sealKey(owner, body.provider, apiKey);
  const rec: KeyRecord = {
    v: 1,
    ...sealed,
    provider: body.provider,
    model,
    createdAt: replacing || !existing ? now : existing.createdAt,
    updatedAt: now,
    valid: true,
    validatedAt: now,
    lastError: null,
    by: actor,
  };
  await writeRecord(kv, owner, rec);
  return c.json({ ok: true, key: await summarize(owner, rec) });
}

async function testKeyFor(owner: string, c: import("hono").Context<Env>, actor: string) {
  requireKeyStorage();
  const kv = kvStore();
  const rec = await readRecord(kv, owner);
  if (!rec) throw new KeyError("no saved key", 404, "no_key");
  await rate(actor, "save");
  const apiKey = await openKey(owner, rec);
  const v = await validateKey(rec.provider, apiKey, rec.model);
  const next: KeyRecord = { ...rec, valid: v.ok, validatedAt: Date.now(), lastError: v.ok ? null : v.error };
  await writeRecord(kv, owner, next);
  return c.json({ ok: v.ok, ...(v.ok ? {} : { error: v.error }), key: await summarize(owner, next) });
}

// Users manage only their own key: the account always comes from the session.
app.get("/api/llm/key", requireSession, requireAllowed, async (c) => {
  const rec = await readRecord(kvStore(), c.var.account);
  return c.json({ enabled: keyStorageConfigured(), key: rec ? await summarize(c.var.account, rec) : null });
});
app.put("/api/llm/key", requireSession, requireAllowed, (c) => saveKeyFor(c.var.account, c, c.var.account));
app.post("/api/llm/key/test", requireSession, requireAllowed, (c) => testKeyFor(c.var.account, c, c.var.account));
app.post("/api/llm/models", requireSession, requireAllowed, (c) => modelsFor(c.var.account, c, c.var.account));
app.delete("/api/llm/key", requireSession, requireAllowed, async (c) => {
  await deleteRecord(kvStore(), c.var.account);
  return c.json({ ok: true, key: null });
});

// Platform default key (ADMIN_ACCOUNTS only, via the /api/admin/* middleware). Takes precedence over NEARAI_API_KEY.
async function platformInfo(): Promise<PlatformKeyInfo> {
  const rec = await readRecord(kvStore(), PLATFORM);
  const stored = rec ? await summarize(PLATFORM, rec) : null;
  return {
    stored,
    env: {
      configured: !!config.nearAiApiKey,
      baseUrl: config.nearAiBaseUrl,
      provider: providerForBaseUrl(config.nearAiBaseUrl),
      model: config.nearAiModel,
      last4: config.nearAiApiKey ? last4(config.nearAiApiKey) : null,
    },
    active: stored?.valid ? "platform" : "env",
  };
}
app.get("/api/admin/llm-key", async (c) => c.json({ enabled: keyStorageConfigured(), ...(await platformInfo()) }));
app.put("/api/admin/llm-key", async (c) => {
  const r = await saveKeyFor(PLATFORM, c, c.var.account);
  return c.json({ ...(await r.json()), ...(await platformInfo()) });
});
app.post("/api/admin/llm-models", (c) => modelsFor(PLATFORM, c, c.var.account));
app.delete("/api/admin/llm-key", async (c) => {
  await deleteRecord(kvStore(), PLATFORM);
  return c.json({ ok: true, ...(await platformInfo()) });
});
/** Tests the stored platform key, or the env key when none is stored. */
app.post("/api/admin/llm-key/test", async (c) => {
  if (await readRecord(kvStore(), PLATFORM)) {
    const r = await testKeyFor(PLATFORM, c, c.var.account);
    return c.json({ ...(await r.json()), tested: "platform", ...(await platformInfo()) });
  }
  await rate(c.var.account, "save");
  const env = envTargetSafe();
  if (!env) return c.json({ ok: false, error: "no stored platform key and NEARAI_API_KEY is not set", tested: "env", ...(await platformInfo()) });
  const v = env.provider ? await validateKey(env.provider, env.apiKey, env.model) : { ok: false as const, status: 0, error: "NEARAI_BASE_URL is not one of the known providers; can't test it here" };
  return c.json({ ok: v.ok, ...(v.ok ? {} : { error: v.error }), tested: "env", ...(await platformInfo()) });
});
const envTargetSafe = () => {
  try {
    return envTarget();
  } catch {
    return null;
  }
};

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
  const td = await getTakedown(found?.ticker ?? id);
  if (td) return c.json({ error: "This token page was taken down by its creator", code: "taken_down", takenDownAt: td.at }, 410);
  if (found) {
    const kv = found.site;
    const extra = await pageExtras(found.ticker, kv.ownerWallet ?? null);
    return c.json({ source: "kv", siteConfig: { ...kv, ...(extra.intents ? { intents: extra.intents } : {}) }, siteUrl: siteUrl(kv.slug ?? id), views: await getViews(found.ticker), ...extra });
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
  const extra = await pageExtras(ticker, rec.owner_id);
  return c.json({ source: "chain", siteConfig: { ...siteConfig, ...(extra.intents ? { intents: extra.intents } : {}) }, siteUrl: siteUrl(ticker), ...extra });
});

/** The creator's NEAR mainnet payout account for Intents tips (KV `intentspay:<account>`, public by nature). */
async function readIntentsPayout(account: string | null): Promise<string | null> {
  if (!account) return null;
  const v = (await kvStore().get(intentsPayKey(account)).catch(() => null)) ?? "";
  return isNearMainnetAccount(v) ? v : null;
}
const mainnetDeployment = () => config.networkId === "mainnet";
/**
 * For the token page: NEAR Intents as offered (null = off or nothing available: tips need a mainnet recipient,
 * buy needs a mainnet token), the network, and the Rhea DCL pool to swap in (buy mode).
 */
async function pageExtras(ticker: string, owner: string | null = null) {
  const cfg = await getIntents(ticker).catch(() => null);
  const intents = cfg?.enabled ? intentsForPage(cfg, owner, await readIntentsPayout(owner), mainnetDeployment()) : null;
  const l = intents && intents.mode !== "tip" ? await getListing(ticker).catch(() => null) : null;
  return {
    intents,
    loofta: await looftaForPage(ticker, owner),
    network: config.networkId,
    rhea: l?.ok && l.venue === "rhea" && l.poolId ? { dcl: config.dclContract, wnear: config.wnearContract, poolId: l.poolId, url: l.url } : null,
  };
}

// ---------- NEAR Intents (1Click) for token pages ----------
const oneClick = () => ({ baseUrl: config.oneClickBaseUrl, jwt: config.oneClickJwt });

/** Supported pay-with assets (1Click /v0/tokens, cached). */
app.get("/api/intents/tokens", async (c) => {
  try {
    const tokens = await oneClickTokens(oneClick());
    c.header("cache-control", "public, max-age=300");
    return c.json({ tokens, network: config.networkId, settlesOn: "mainnet" });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

/**
 * Quote for a token page's widget, always on NEAR mainnet (every deployment). The server picks the destination
 * (tips: the creator's mainnet recipient; buy: wNEAR to the visitor's account) and never adds app fees.
 * Buy is refused on testnet deployments (the token and its pool aren't on mainnet).
 */
app.post("/api/intents/quote", async (c) => {
  const body = IntentsQuoteRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid request", issues: body.error.issues }, 400);
  const id = body.data.site.toLowerCase();
  if (!SITE_ID_RE.test(id)) return c.json({ error: "invalid ticker or slug" }, 400);
  const found = await findSite(id);
  const ticker = found?.ticker ?? id;
  if (await getTakedown(ticker)) return c.json({ error: "This token page was taken down", code: "taken_down" }, 410);
  const owner = found?.site.ownerWallet ?? (await getTokenRecord(ticker).catch(() => null))?.owner_id;
  if (!owner) return c.json({ error: "no such token" }, 404);
  let tokens;
  try {
    tokens = await oneClickTokens(oneClick());
  } catch (e) {
    return c.json({ error: `NEAR Intents is unreachable: ${(e as Error).message}` }, 502);
  }
  if (!tokens.some((t) => t.assetId === body.data.originAsset)) return c.json({ error: "that asset isn't supported by NEAR Intents" }, 400);
  const cfg = await getIntents(ticker);
  const plan = planQuote(body.data, cfg, tipRecipient(cfg, owner, await readIntentsPayout(owner), mainnetDeployment()), mainnetDeployment());
  if (!plan.ok) return c.json({ error: plan.error }, plan.status);
  const r = await oneClickQuote(oneClick(), plan.body).catch((e) => ({ ok: false, status: 502, j: { message: (e as Error).message } }));
  if (!r.ok) return c.json({ error: `NEAR Intents: ${r.j?.message ?? `HTTP ${r.status}`}` }, r.status >= 500 ? 502 : 400);
  try {
    return c.json(shapeQuote(r.j, plan.dry, plan.preview));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

async function intentsSettings(account: string): Promise<IntentsSettings> {
  const payout = await readIntentsPayout(account);
  return { payout, tipRecipient: tipRecipient(null, account, payout, mainnetDeployment()), buy: mainnetDeployment(), network: config.networkId };
}
app.get("/api/intents/settings", requireSession, requireAllowed, async (c) => c.json(await intentsSettings(c.var.account)));
/** The creator's default NEAR mainnet account for tips on all their pages ({account: null} clears it). */
app.put("/api/intents/payout", requireSession, requireAllowed, async (c) => {
  const body = IntentsPayoutRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid account" }, 400);
  const kv = kvStore();
  if (body.data.account === null) await (kv.delete ? kv.delete(intentsPayKey(c.var.account)) : kv.put(intentsPayKey(c.var.account), ""));
  else await kv.put(intentsPayKey(c.var.account), body.data.account);
  return c.json({ ok: true, ...(await intentsSettings(c.var.account)) });
});

/** Swap status for a deposit address that 1Click issued (proxied /v0/status). */
app.get("/api/intents/status", async (c) => {
  const addr = c.req.query("depositAddress") ?? "";
  const memo = c.req.query("depositMemo") || undefined;
  if (!DEPOSIT_ADDRESS_RE.test(addr) || (memo && !/^[A-Za-z0-9._:\-]{1,128}$/.test(memo))) return c.json({ error: "invalid deposit address" }, 400);
  const r = await oneClickStatus(oneClick(), addr, memo).catch((e) => ({ ok: false as const, status: 502, error: (e as Error).message }));
  if (!r.ok) return c.json({ error: r.error }, r.status === 404 ? 404 : 502);
  return c.json(r);
});

// ---------- Loofta: pay the creator (README "Loofta") ----------
// The creator's Loofta key and payout targets are encrypted like AI keys and never leave the server. Pages and
// the public launches list only get on/off, the route and a masked label; payout URLs come from POST checkout.

/** Public page view: null when off or when the creator has no usable route (no key and no payout target). */
async function looftaForPage(ticker: string, owner: string | null) {
  const page = await readLooftaPage(kvStore(), ticker).catch(() => null);
  if (!page?.enabled) return null;
  const r = await resolveRoute(kvStore(), ticker, owner, page).catch(() => null);
  return r ? looftaPublic(r) : null;
}

/** For "My tokens" (public list): no decrypting, no targets. Absent when the page has no Loofta record. */
async function looftaState(ticker: string, owner: string): Promise<LooftaPageState | null> {
  const page = await readLooftaPage(kvStore(), ticker);
  if (!page) return null;
  return { enabled: page.enabled, custom: !!page.payTo, ready: !!page.payTo || (await ownerHasLoofta(owner)) };
}
async function ownerHasLoofta(owner: string): Promise<boolean> {
  const kv = kvStore();
  const [k, p] = await Promise.all([readLooftaKey(kv, owner), readPayTo(kv, owner)]);
  return !!k?.valid || !!p;
}

const requireLooftaStorage = () => {
  if (!keyStorageConfigured()) throw new KeyError("saving Loofta settings isn't enabled on this server yet (KEY_ENCRYPTION_KEY)", 503, "key_storage_unconfigured");
};
async function looftaSettings(account: string): Promise<LooftaSettings> {
  const kv = kvStore();
  const [k, p] = await Promise.all([readLooftaKey(kv, account), readPayTo(kv, account)]);
  const key = k ? await summarizeLooftaKey(account, k) : null;
  const pt = p ? await openPayTo(account, p) : null;
  return {
    enabled: keyStorageConfigured(),
    key,
    payTo: pt ? summarizePayTo(pt) : null,
    route: key?.valid ? "checkout" : pt ? "send" : null,
    network: config.networkId,
  };
}

app.get("/api/loofta/settings", requireSession, requireAllowed, async (c) => c.json(await looftaSettings(c.var.account)));

/** Validate with Loofta (harmless lookup) and store encrypted. Nothing is stored if Loofta rejects the key. */
app.put("/api/loofta/key", requireSession, requireAllowed, async (c) => {
  requireLooftaStorage();
  const text = await c.req.text().catch(() => "");
  if (text.length > 2048) throw new KeyError("request too large", 400);
  let raw: unknown = null;
  try {
    raw = (JSON.parse(text) as { apiKey?: unknown })?.apiKey;
  } catch {}
  const apiKey = cleanLooftaKey(raw);
  const account = c.var.account;
  if (!(await takeKeyRate(kvStore(), account, "loofta", KEY_RATE_LIMIT))) throw new KeyError(`too many Loofta key saves/tests; limit is ${KEY_RATE_LIMIT} per hour`, 429, "rate_limited");
  const v = await validateLooftaKey(apiKey);
  if (!v.ok) throw new KeyError(`${v.error} The key was not saved.`, v.status === 429 ? 429 : 400, "key_invalid");
  const kv = kvStore();
  const existing = await readLooftaKey(kv, account);
  const now = Date.now();
  const rec: LooftaKeyRecord = { v: 1, ...(await sealLooftaKey(account, apiKey)), createdAt: existing?.createdAt ?? now, updatedAt: now, valid: true, validatedAt: now, lastError: null };
  await writeLooftaKey(kv, account, rec);
  return c.json({ ok: true, ...(await looftaSettings(account)) });
});
app.post("/api/loofta/key/test", requireSession, requireAllowed, async (c) => {
  requireLooftaStorage();
  const account = c.var.account;
  const kv = kvStore();
  const rec = await readLooftaKey(kv, account);
  if (!rec) throw new KeyError("no saved Loofta key", 404, "no_key");
  if (!(await takeKeyRate(kv, account, "loofta", KEY_RATE_LIMIT))) throw new KeyError(`too many Loofta key saves/tests; limit is ${KEY_RATE_LIMIT} per hour`, 429, "rate_limited");
  const v = await validateLooftaKey(await openLooftaKey(account, rec));
  // A Loofta outage shouldn't switch pages off: only an explicit rejection marks the key invalid.
  const rejected = !v.ok && v.status === 400;
  await writeLooftaKey(kv, account, { ...rec, valid: v.ok || (rec.valid && !rejected), validatedAt: Date.now(), lastError: v.ok ? null : v.error });
  return c.json({ ok: v.ok, ...(v.ok ? {} : { error: v.error }), ...(await looftaSettings(account)) });
});
app.delete("/api/loofta/key", requireSession, requireAllowed, async (c) => {
  await deleteLooftaKey(kvStore(), c.var.account);
  return c.json({ ok: true, ...(await looftaSettings(c.var.account)) });
});

/** The creator's default payout target for the keyless route (body {payTo: null} clears it). */
app.put("/api/loofta/payto", requireSession, requireAllowed, async (c) => {
  const j = (await c.req.json().catch(() => null)) as { payTo?: unknown } | null;
  if (!j || !("payTo" in j)) return c.json({ error: "payTo is required (null clears it)" }, 400);
  const account = c.var.account;
  if (j.payTo === null) {
    await deletePayTo(kvStore(), account);
    return c.json({ ok: true, ...(await looftaSettings(account)) });
  }
  requireLooftaStorage();
  const p = LooftaPayTo.safeParse(j.payTo);
  if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "invalid payout target" }, 400);
  await writePayTo(kvStore(), account, await sealPayTo(account, p.data));
  return c.json({ ok: true, ...(await looftaSettings(account)) });
});

/** Loofta widget on/off for many token pages (creator or admin), optionally with a per-page payout target. */
app.post("/api/tokens/loofta", requireSession, requireAllowed, async (c) => {
  const body = TokensLooftaRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid request", issues: body.error.issues }, 400);
  const { tokens, loofta } = body.data;
  if (loofta.payTo || loofta.enabled) requireLooftaStorage();
  const kv = kvStore();
  const results: TokensActionResult[] = [];
  let forbidden = 0;
  for (const ticker of [...new Set(tokens)]) {
    const a = await tokenAccess(ticker, c.var.account);
    if (!a.ok) {
      if (a.status === 403) forbidden++;
      results.push({ ticker, ok: false, note: a.note });
      continue;
    }
    const page = await readLooftaPage(kv, ticker);
    const next: LooftaPageRecord = { enabled: loofta.enabled, ...(page?.payTo ? { payTo: page.payTo } : {}) };
    if (loofta.payTo === null) delete next.payTo;
    else if (loofta.payTo) next.payTo = await sealPayTo(pageOwnerId(ticker), loofta.payTo);
    if (next.enabled && !(await resolveRoute(kv, ticker, a.creator ?? null, next))) {
      results.push({ ticker, ok: false, note: "set up Loofta first: save your Loofta API key or a payout target (Studio → Loofta)" });
      continue;
    }
    await writeLooftaPage(kv, ticker, next);
    results.push({ ticker, ok: true });
  }
  const status = results.some((r) => r.ok) ? 200 : forbidden ? 403 : results.length && results.every((r) => /set up Loofta/.test(r.note ?? "")) ? 409 : 404;
  return c.json({ results, ...(status !== 200 ? { error: results[0]?.note ?? "nothing changed" } : {}) }, status);
});

/**
 * A visitor clicked "Pay with Loofta". Public, rate-limited per IP. Always live, on every deployment (Loofta has
 * no testnet; payments are real): a fresh Loofta checkout (owner's key) or the Send link with the payout target.
 */
app.post("/api/loofta/checkout", async (c) => {
  const body = LooftaCheckoutRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid request", issues: body.error.issues }, 400);
  const id = body.data.site.toLowerCase();
  if (!SITE_ID_RE.test(id)) return c.json({ error: "invalid ticker or slug" }, 400);
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!(await takeCheckoutRate(kvStore(), ip))) return c.json({ error: `too many payment requests from here (limit ${CHECKOUT_RATE_LIMIT} per 10 minutes); try again later` }, 429);
  const found = await findSite(id);
  const ticker = found?.ticker ?? id;
  if (await getTakedown(ticker)) return c.json({ error: "This token page was taken down", code: "taken_down" }, 410);
  const owner = found?.site.ownerWallet ?? (await getTokenRecord(ticker).catch(() => null))?.owner_id ?? null;
  if (!owner) return c.json({ error: "no such token" }, 404);
  const page = await readLooftaPage(kvStore(), ticker);
  if (!page?.enabled) return c.json({ error: "Loofta payments aren't enabled on this page" }, 403);
  const r = await resolveRoute(kvStore(), ticker, owner, page, true);
  if (!r) return c.json({ error: "the creator hasn't finished setting up Loofta payments" }, 409);
  const amount = Math.round(body.data.amount * 100) / 100;
  const base = { route: r.route, label: r.label, amount };
  const name = found?.site.branding.ticker ?? ticker.toUpperCase();
  if (r.route === "checkout") {
    let url: string;
    try {
      url = await createPaymentLink(r.apiKey!, amount, cleanMessage(body.data.message, `Tip for $${name}`), siteUrl(found?.site.slug ?? ticker));
    } catch (e) {
      // Loofta definitively refused the key (revoked, or its account can't receive payments): mark it invalid so the
      // page falls back to the payout target (or hides) instead of failing every click; the creator sees lastError.
      if (e instanceof KeyError && (e.code === "provider_auth" || e.code === "provider_no_owner")) {
        const kv = kvStore();
        const rec = await readLooftaKey(kv, owner);
        if (rec) await writeLooftaKey(kv, owner, { ...rec, valid: false, validatedAt: Date.now(), lastError: e.code === "provider_no_owner" ? "Loofta says this key's account can't receive payments yet. Finish your Loofta account setup, then save or test the key again." : "Loofta rejected this key (invalid or revoked). Create a new one in Loofta → API key & branding." });
      }
      throw e;
    }
    return c.json({ ...base, preview: false, url });
  }
  return c.json({ ...base, preview: false, url: sendUrl(r.payTo!, amount) });
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

const getListing = async (ticker: string): Promise<Listing | null> => {
  const raw = await kvStore().get(`listing:${ticker}`);
  return raw ? (JSON.parse(raw) as Listing) : null;
};

const withTakedown = async (l: LaunchedToken): Promise<LaunchedToken> => {
  const [td, intents, loofta] = await Promise.all([getTakedown(l.ticker), getIntents(l.ticker).catch(() => null), looftaState(l.ticker, l.ownerId).catch(() => null)]);
  const intentsState = intents?.enabled ? intentsPageState(intents, l.ownerId, await readIntentsPayout(l.ownerId), mainnetDeployment()) : null;
  const withIntents = { ...l, ...(intents ? { intents } : {}), ...(intentsState ? { intentsState } : {}), ...(loofta ? { loofta } : {}) };
  return td ? { ...withIntents, deletedAt: td.at, ...(td.byAdmin ? { deletedByAdmin: true } : {}) } : withIntents;
};

const toLaunched = async (r: TokenRecord): Promise<LaunchedToken> => {
  const kv = await getSite(r.ticker);
  const s = parseCompact(r.site);
  const l = await getListing(r.ticker);
  const venue = l?.ok && l.tokenId === r.token_id ? l.venue : "yeetpad";
  return {
    venue,
    venueUrl: venue === "yeetpad" ? null : (l?.url ?? null),
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
    txHash: kv?.tokenLaunch.txHash ?? null,
  };
};

/** "My launches": tokens owned by an account, newest first (public; on-chain data). */
app.get("/api/launches/:account", async (c) => {
  const account = NearAccountId.safeParse(c.req.param("account"));
  if (!account.success) return c.json({ error: "invalid account id" }, 400);
  const from = Number(c.req.query("from") ?? 0) || 0;
  const limit = Math.min(50, Number(c.req.query("limit") ?? 20) || 20);
  const recs = await getTokensByOwner(account.data, from, limit);
  const launches = await Promise.all(recs.map(toLaunched));
  const includeDeleted = c.req.query("includeDeleted") === "1";
  // Nearly tokens live outside our factory; they come from the KV index (first page only).
  if (from === 0) {
    const idx = [
      ...(JSON.parse((await kvStore().get(`nearly-by:${account.data}`)) ?? "[]") as { ticker: string; tokenId: string; at: number }[]).map((x) => ({ ...x, venue: "nearly" as const })),
      ...(JSON.parse((await kvStore().get(`justhoot-by:${account.data}`)) ?? "[]") as { ticker: string; tokenId: string; at: number }[]).map((x) => ({ ...x, venue: "justhoot" as const })),
    ];
    for (const n of idx) {
      const kv = await getSite(n.ticker);
      const l = await getListing(n.ticker);
      launches.push({
        ticker: n.ticker,
        tokenId: n.tokenId,
        ownerId: account.data,
        createdAt: n.at,
        name: kv?.branding.name ?? null,
        tagline: kv?.branding.tagline ?? null,
        colors: kv?.theme.colors ?? null,
        slug: kv?.slug ?? null,
        views: await getViews(n.ticker),
        gaId: kv?.analytics?.gaId ?? null,
        siteUrl: siteUrl(kv?.slug ?? n.ticker),
        explorerUrl: n.venue === "justhoot" ? `https://nearblocks.io/address/${n.tokenId}` : `${config.explorerBase}/address/${n.tokenId}`,
        venue: n.venue,
        txHash: kv?.tokenLaunch.txHash ?? l?.txHash ?? null,
        venueUrl: l?.url ?? (n.venue === "justhoot" ? justhootUrl(n.tokenId) : nearlyUrl(n.tokenId)),
      });
    }
    launches.sort((a, b) => b.createdAt - a.createdAt);
  }
  // Taken-down tokens are hidden unless asked for; `scanned` = factory records read (for client paging).
  const marked = await Promise.all(launches.map(withTakedown));
  return c.json({ account: account.data, launches: includeDeleted ? marked : marked.filter((l) => !l.deletedAt), scanned: recs.length });
});

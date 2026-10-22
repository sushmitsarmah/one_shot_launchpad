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
  TokensIntentsRequest,
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
} from "@osl/schema";
import { buildListParams, computePoints, listingCost, poolIdFor, rheaPoolUrl } from "./rhea";
import { config } from "./config";
import { DEPOSIT_ADDRESS_RE, oneClickQuote, oneClickStatus, oneClickTokens, planQuote, shapeQuote } from "./intents";
import { generateIdeas } from "./llm";
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

  const bal = await getVaultBalance(ownerWallet);
  if (bal < cost) {
    return c.json({ error: `insufficient vault balance: need ${formatNear(cost)} NEAR for ${count} idea(s), have ${formatNear(bal)}` }, 402);
  }

  const ideas = await generateIdeas(prompt, count, body.data.avoid ?? [], body.data.seq);
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
async function tokenAccess(ticker: string, account: string): Promise<{ ok: true; admin: boolean } | { ok: false; status: 403 | 404; note: string }> {
  const rec = await getTokenRecord(ticker).catch(() => null);
  const creator = rec?.owner_id ?? (await findSite(ticker))?.site.ownerWallet ?? null;
  const admin = isAdmin(account, config);
  if (!creator) return admin ? { ok: true, admin } : { ok: false, status: 404, note: "no such token" };
  if (creator === account) return { ok: true, admin: false };
  if (admin) return { ok: true, admin: true };
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
  if (intents.recipient && config.networkId === "mainnet" && /\.testnet$/.test(intents.recipient))
    return c.json({ error: "tips need a NEAR mainnet account" }, 400);
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
    const extra = await pageExtras(found.ticker);
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
  const extra = await pageExtras(ticker);
  return c.json({ source: "chain", siteConfig: { ...siteConfig, ...(extra.intents ? { intents: extra.intents } : {}) }, siteUrl: siteUrl(ticker), ...extra });
});

/** For the token page: NEAR Intents settings (null = off), the network, and the Rhea DCL pool to swap in (buy mode). */
async function pageExtras(ticker: string) {
  const intents = await getIntents(ticker).catch(() => null);
  const l = intents?.enabled ? await getListing(ticker).catch(() => null) : null;
  return {
    intents: intents?.enabled ? intents : null,
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
 * Quote for a token page's widget. The server picks the destination (tips: the creator; buy: wNEAR to the
 * visitor's account), never adds app fees, and off mainnet only returns price-only (dry) quotes.
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
  const plan = planQuote(body.data, await getIntents(ticker), owner, config.networkId === "mainnet");
  if (!plan.ok) return c.json({ error: plan.error }, plan.status);
  const r = await oneClickQuote(oneClick(), plan.body).catch((e) => ({ ok: false, status: 502, j: { message: (e as Error).message } }));
  if (!r.ok) return c.json({ error: `NEAR Intents: ${r.j?.message ?? `HTTP ${r.status}`}` }, r.status >= 500 ? 502 : 400);
  try {
    return c.json(shapeQuote(r.j, plan.dry, plan.preview));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
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
  const [td, intents] = await Promise.all([getTakedown(l.ticker), getIntents(l.ticker).catch(() => null)]);
  const withIntents = intents ? { ...l, intents } : l;
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

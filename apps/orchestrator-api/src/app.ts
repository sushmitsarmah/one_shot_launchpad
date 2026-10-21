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
  type MeResponse,
  type WaitlistResponse,
  type GenerateResponse,
  type LaunchResponse,
  type Listing,
  type RheaOptions,
  NearlyFinalizeRequest,
  NearlyPrepareRequest,
  QuoteRequest,
  type NearlyFinalizeResponse,
  type NearlyLaunchTx,
  type NearlyPrepareResponse,
  type QuoteResponse,
} from "@osl/schema";
import { buildListParams, computePoints, listingCost, rheaPoolUrl } from "./rhea";
import { config } from "./config";
import { generateIdeas } from "./llm";
import { tokenIconDataUri } from "./icon";
import { buildSiteConfig, claimSlug, compactSite, findSite, getSite, getViews, kvStore, putSite, saveSite, siteStoreKind, siteUrl } from "./sites";
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
    llmMock: config.llmMock,
    nearMock: config.nearMock,
    model: config.nearAiModel,
    vault: config.vaultContract,
    factory: config.factoryContract,
    aiComputeCost: config.aiComputeCostYocto,
    maxBatch: 5,
    venues: {
      rhea: { dcl: config.dclContract, wnear: config.wnearContract, defaultFdvNear: config.rheaDefaultFdvNear },
      nearly: { factory: config.nearlyFactory, chunk: config.nearlyBatchChunk },
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
    const params = buildListParams({
      tokenId,
      supply: BigInt(config.tokenTotalSupply),
      decimals: config.tokenDecimals,
      fdvNear: opts?.openingFdvNear ?? config.rheaDefaultFdvNear,
      creatorPct: opts?.creatorPct ?? 0,
      creatorDclStorage: await creatorDclStorageNeeded(owner),
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
  if (listOn === "nearly") {
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
    const idxKey = `nearly-by:${owner}`;
    const idx = JSON.parse((await kv.get(idxKey)) ?? "[]") as { ticker: string; tokenId: string; at: number }[];
    if (!idx.some((x) => x.tokenId === ev.token)) idx.unshift({ ticker, tokenId: ev.token, at: Date.now() });
    await kv.put(idxKey, JSON.stringify(idx.slice(0, 500)));
    await kv.delete?.(pendingKey(ticker));
    results.push({ ticker, ok: true, tokenId: ev.token, slug: site.slug ?? null, siteUrl: siteUrl(site.slug ?? ticker), error: null, listing });
  }
  return c.json({ results } satisfies NearlyFinalizeResponse, results.some((r) => r.ok) ? 200 : 400);
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

const getListing = async (ticker: string): Promise<Listing | null> => {
  const raw = await kvStore().get(`listing:${ticker}`);
  return raw ? (JSON.parse(raw) as Listing) : null;
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
  // Nearly tokens live outside our factory; they come from the KV index (first page only).
  if (from === 0) {
    const idx = JSON.parse((await kvStore().get(`nearly-by:${account.data}`)) ?? "[]") as { ticker: string; tokenId: string; at: number }[];
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
        explorerUrl: `${config.explorerBase}/address/${n.tokenId}`,
        venue: "nearly",
        venueUrl: l?.url ?? nearlyUrl(n.tokenId),
      });
    }
    launches.sort((a, b) => b.createdAt - a.createdAt);
  }
  return c.json({ account: account.data, launches });
});

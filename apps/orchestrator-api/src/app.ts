import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import {
  GenerateRequest,
  LaunchRequest,
  SessionRequest,
  NearAccountId,
  SiteConfig,
  formatNear,
  type GenerateResponse,
  type LaunchResponse,
} from "@osl/schema";
import { config } from "./config";
import { generateIdea } from "./llm";
import { AuthError, consumeNonceInMemory, issueSession, verifySession, verifySignIn } from "./auth";
import {
  accountExists,
  deductAiCompute,
  executeSponsoredLaunch,
  getRequiredLaunchDeposit,
  getVaultBalance,
  isFullAccessKey,
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
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  }),
);

app.onError((err, c) => {
  if (err instanceof AuthError) return c.json({ error: err.message }, err.status as 401 | 403);
  console.error(err);
  const msg = err instanceof Error ? err.message : String(err);
  const status = /insufficient balance/i.test(msg) ? 402 : 500;
  return c.json({ error: msg }, status);
});

app.get("/", (c) => c.json({ ok: true, service: "one_shot_launchpad orchestrator", network: config.networkId }));
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    llmMock: config.llmMock,
    nearMock: config.nearMock,
    model: config.nearAiModel,
    vault: config.vaultContract,
    factory: config.factoryContract,
    aiComputeCost: config.aiComputeCostYocto,
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
  return c.json(await issueSession(accountId, sessionSecret()));
});

/** Requires `Authorization: Bearer <session token>`; sets c.var.account. */
const requireSession = createMiddleware<Env>(async (c, next) => {
  const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
  if (!m) throw new AuthError("missing session: sign in with your wallet");
  c.set("account", await verifySession(m[1], sessionSecret()));
  await next();
});

app.get("/api/auth/me", requireSession, (c) => c.json({ accountId: c.var.account }));

function ownerFor(c: { var: { account: string } }, claimed?: string) {
  if (claimed && claimed !== c.var.account) throw new AuthError(`ownerWallet ${claimed} does not match the signed-in account`, 403);
  return c.var.account;
}

app.post("/api/generate", requireSession, async (c) => {
  const body = GenerateRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const { prompt } = body.data;
  const ownerWallet = ownerFor(c, body.data.ownerWallet);
  const cost = BigInt(config.aiComputeCostYocto);

  const bal = await getVaultBalance(ownerWallet);
  if (bal < cost) {
    return c.json({ error: `insufficient vault balance: need ${formatNear(cost)} NEAR, have ${formatNear(bal)}` }, 402);
  }

  const idea = await generateIdea(prompt);
  // Charge only after a valid idea was produced.
  const txHash = cost > 0n ? await deductAiCompute(ownerWallet, cost) : null;
  const res: GenerateResponse = { idea, charged: cost.toString(), txHash };
  return c.json(res);
});

app.post("/api/launch", requireSession, async (c) => {
  const body = LaunchRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const { idea } = body.data;
  const ownerWallet = ownerFor(c, body.data.ownerWallet);
  const tokenAccount = `${idea.ticker}.${config.factoryContract}`;

  if (await accountExists(tokenAccount)) {
    return c.json({ error: `ticker "${idea.ticker}" is taken (${tokenAccount}); edit it and retry` }, 409);
  }
  const deposit = await getRequiredLaunchDeposit();
  const bal = await getVaultBalance(ownerWallet);
  if (bal < deposit) {
    return c.json({ error: `insufficient vault balance: launch needs ~${formatNear(deposit)} NEAR, have ${formatNear(bal)}` }, 402);
  }

  const { tokenId, txHash } = await executeSponsoredLaunch(
    ownerWallet,
    {
      ticker: idea.ticker,
      name: idea.name,
      symbol: idea.ticker.toUpperCase(),
      decimals: config.tokenDecimals,
      total_supply: config.tokenTotalSupply,
    },
    deposit,
  );
  if (!tokenId) {
    return c.json({ error: "launch failed on-chain; your balance was refunded", txHash, explorerUrl: `${config.explorerBase}/txns/${txHash}` }, 502);
  }

  const siteConfig = SiteConfig.parse({
    siteId: `${idea.ticker}-${Date.now().toString(36)}`,
    ownerWallet,
    ecosystem: "near",
    blueprint: "meme-landing",
    theme: { colors: idea.colors, fonts: { heading: "Space Grotesk", body: "Inter" } },
    branding: { name: idea.name, ticker: idea.ticker.toUpperCase(), tagline: idea.tagline, description: idea.description },
    tokenLaunch: { contractOrMintAddress: tokenId, buyUrl: `${config.explorerBase}/token/${tokenId}` },
  });
  const res: LaunchResponse = { tokenId, txHash, explorerUrl: `${config.explorerBase}/txns/${txHash}`, siteConfig };
  return c.json(res);
});

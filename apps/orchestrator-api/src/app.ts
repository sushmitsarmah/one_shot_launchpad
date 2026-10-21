import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  GenerateRequest,
  LaunchRequest,
  NearAccountId,
  SiteConfig,
  formatNear,
  type GenerateResponse,
  type LaunchResponse,
} from "@osl/schema";
import { config } from "./config";
import { generateIdea } from "./llm";
import {
  accountExists,
  deductAiCompute,
  executeSponsoredLaunch,
  getRequiredLaunchDeposit,
  getVaultBalance,
} from "./near";

export const app = new Hono<{ Bindings: Record<string, unknown> }>();

app.use(
  "/api/*",
  cors({
    // Resolved per request so Worker env bindings (applied on first request) are honoured.
    origin: (origin) => (config.corsOrigins.includes("*") ? "*" : config.corsOrigins.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.onError((err, c) => {
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

app.post("/api/generate", async (c) => {
  const body = GenerateRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const { prompt, ownerWallet } = body.data;
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

app.post("/api/launch", async (c) => {
  const body = LaunchRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const { ownerWallet, idea } = body.data;
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

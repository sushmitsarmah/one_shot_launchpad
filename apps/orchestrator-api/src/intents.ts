/**
 * NEAR Intents 1Click proxy for token pages (https://docs.near-intents.org, OpenAPI /docs/v0/openapi.yaml).
 * The browser could call 1Click directly (CORS is open), but proxying lets the server: pick the
 * destination (tips always go to the creator), force price-only quotes off mainnet, never add app fees,
 * and attach the optional partner JWT from a Worker secret.
 */
import type { IntentsConfig, IntentsQuoteRequest } from "@osl/schema";

/** Mainnet 1Click asset ids that tokens are delivered as on NEAR. */
export const WNEAR_ASSET = "nep141:wrap.near";
export const USDC_NEAR_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** Valid mainnet account used only for price-only (dry) quotes where no real recipient applies (testnet). */
export const PREVIEW_ACCOUNT = "intents.near";

export interface OneClickToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price?: number;
}

export interface OneClickOpts {
  baseUrl: string;
  jwt?: string;
  fetch?: typeof fetch;
}

const headers = (o: OneClickOpts) => ({
  "content-type": "application/json",
  ...(o.jwt ? { authorization: `Bearer ${o.jwt}` } : {}),
});

let tokenCache: { at: number; tokens: OneClickToken[] } | null = null;
export const resetTokenCache = () => (tokenCache = null);

/** /v0/tokens, trimmed and cached for 5 minutes. */
export async function oneClickTokens(o: OneClickOpts): Promise<OneClickToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < 5 * 60_000) return tokenCache.tokens;
  const r = await (o.fetch ?? fetch)(`${o.baseUrl}/v0/tokens`, { headers: headers(o) });
  if (!r.ok) throw new Error(`1Click tokens: HTTP ${r.status}`);
  const raw = (await r.json()) as OneClickToken[];
  const tokens = raw
    .filter((t) => typeof t.assetId === "string" && typeof t.decimals === "number")
    .map((t) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals, ...(typeof t.price === "number" ? { price: t.price } : {}) }));
  tokenCache = { at: Date.now(), tokens };
  return tokens;
}

export type QuotePlan =
  | { ok: true; body: Record<string, unknown>; dry: boolean; preview: boolean }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Builds the 1Click /v0/quote body for a token page. Never includes appFees (Yeetpad takes no fee).
 * - tip: destination = creator's recipient (or owner) as USDC/wNEAR on NEAR.
 * - buy: destination = the visitor's NEAR account as wNEAR (then a Rhea swap on the page).
 * Off mainnet: always dry (price only, no deposit address) with placeholder accounts.
 */
export function planQuote(req: IntentsQuoteRequest, cfg: IntentsConfig | null, owner: string, mainnet: boolean, now = Date.now()): QuotePlan {
  if (!cfg?.enabled) return { ok: false, status: 403, error: "NEAR Intents isn't enabled for this token" };
  const mode = cfg.mode ?? "both";
  if (mode !== "both" && mode !== req.mode) return { ok: false, status: 403, error: `this token page only offers ${mode}` };
  const preview = !mainnet;
  const dry = preview || !!req.dry;
  const destinationAsset = req.mode === "buy" ? WNEAR_ASSET : cfg.tipAsset === "wnear" ? WNEAR_ASSET : USDC_NEAR_ASSET;
  let recipient: string;
  if (req.mode === "tip") recipient = preview ? PREVIEW_ACCOUNT : (cfg.recipient ?? owner);
  else recipient = preview ? PREVIEW_ACCOUNT : (req.recipient ?? PREVIEW_ACCOUNT);
  if (!dry) {
    if (!req.refundTo) return { ok: false, status: 400, error: "a refund address on the chain you pay from is required" };
    if (req.mode === "buy" && !req.recipient) return { ok: false, status: 400, error: "your NEAR account (that receives wNEAR) is required" };
    if (/\.testnet$/.test(recipient)) return { ok: false, status: 400, error: "the recipient must be a NEAR mainnet account" };
  }
  const refund = dry && !req.refundTo ? { refundTo: PREVIEW_ACCOUNT, refundType: "INTENTS" } : { refundTo: req.refundTo, refundType: "ORIGIN_CHAIN" };
  return {
    ok: true,
    dry,
    preview,
    body: {
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: req.slippageBps ?? 100,
      originAsset: req.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset,
      amount: req.amount,
      ...refund,
      recipient,
      recipientType: "DESTINATION_CHAIN",
      // Refunds start after this; long enough for slow chains (BTC needs confirmations).
      deadline: new Date(now + 3 * 3600_000).toISOString(),
      referral: "yeetpad",
    },
  };
}

/** Shapes a 1Click quote response for the page: deposit fields only ever come from 1Click's answer. */
export function shapeQuote(j: any, dry: boolean, preview: boolean) {
  const q = j?.quote ?? {};
  const out = {
    preview,
    dry,
    amountIn: String(q.amountIn ?? ""),
    amountInFormatted: String(q.amountInFormatted ?? ""),
    amountInUsd: q.amountInUsd ?? null,
    amountOut: String(q.amountOut ?? ""),
    amountOutFormatted: String(q.amountOutFormatted ?? ""),
    amountOutUsd: q.amountOutUsd ?? null,
    minAmountOut: String(q.minAmountOut ?? ""),
    timeEstimate: typeof q.timeEstimate === "number" ? q.timeEstimate : null,
    destinationAsset: j?.quoteRequest?.destinationAsset ?? null,
    recipient: j?.quoteRequest?.recipient ?? null,
    depositAddress: !dry && typeof q.depositAddress === "string" ? q.depositAddress : null,
    depositMemo: !dry && typeof q.depositMemo === "string" ? q.depositMemo : null,
    deadline: !dry ? (q.deadline ?? null) : null,
    signature: j?.signature ?? null,
    correlationId: j?.correlationId ?? null,
  };
  if (!dry && !out.depositAddress) throw new Error("1Click returned no deposit address");
  return out;
}

export async function oneClickQuote(o: OneClickOpts, body: Record<string, unknown>) {
  const r = await (o.fetch ?? fetch)(`${o.baseUrl}/v0/quote`, { method: "POST", headers: headers(o), body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as any;
  return { ok: r.ok, status: r.status, j };
}

export const DEPOSIT_ADDRESS_RE = /^[A-Za-z0-9._:\-]{10,128}$/;

export async function oneClickStatus(o: OneClickOpts, depositAddress: string, depositMemo?: string) {
  const u = new URL(`${o.baseUrl}/v0/status`);
  u.searchParams.set("depositAddress", depositAddress);
  if (depositMemo) u.searchParams.set("depositMemo", depositMemo);
  const r = await (o.fetch ?? fetch)(u.toString(), { headers: headers(o) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) return { ok: false as const, status: r.status, error: String(j?.message ?? `HTTP ${r.status}`) };
  const d = j.swapDetails ?? {};
  return {
    ok: true as const,
    status: String(j.status),
    updatedAt: j.updatedAt ?? null,
    amountInFormatted: d.amountInFormatted ?? null,
    amountOutFormatted: d.amountOutFormatted ?? null,
    destinationChainTxHashes: Array.isArray(d.destinationChainTxHashes) ? d.destinationChainTxHashes.map((t: any) => t?.hash).filter(Boolean) : [],
    refundedAmountFormatted: d.refundedAmountFormatted ?? null,
  };
}

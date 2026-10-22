/**
 * JustHoot (justhoot.fun) launch venue: the creator's wallet calls `launch_meme` on the v2 launcher.
 * Schema checked against their JS bundle (assets/trading-*.js, 2026-10-22) and mainnet txs, e.g.
 * EzSXuQTcDbs3wUzj4DSUKSoVcjxnVGy777nTfAEx9RRn (no first buy, 457 Tgas, 0.0909 NEAR).
 * The launcher creates `<symbol lowercase>.<launcher>`, opens a Rhea DCL pool token|wNEAR (1%) and adds the supply
 * one-sided. The LP position stays with JustHoot's pool creator (`v2-pool-creator.justhoot.near`); the creator
 * is the token's fee recipient (`shares.token_owner_bps`).
 */
import { JsonRpcProvider } from "near-api-js";
import type { LaunchIdea } from "@osl/schema";
import { config, configVersion } from "./config";

export const ICON_MAX_CHARS = 7000;
export const NAME_MAX = 32;
export const SYMBOL_RE = /^[A-Za-z0-9]{1,10}$/;
/** Used when `get_launch_gas` can't be read (observed 446 Tgas without an icon, 461 with a 7000-char one). */
export const FALLBACK_GAS_TGAS = 460n;

export interface LaunchMemeArgs {
  name: string;
  symbol: string;
  icon: string | null;
  reference: string | null;
  reference_hash: string | null;
  quote_token_id: string;
  dev_buy_quote_max: string | null;
  transfer_fee_pips: number;
  shares: { token_owner_bps: number; burn_bps: number; holders_bps: number };
}

export type ViewFn = (contractId: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

let provider: JsonRpcProvider | null = null;
let builtFor = -1;
/** JustHoot is mainnet-only, so its views use their own RPC (JUSTHOOT_RPC_URL), not the app's testnet RPC. */
export const rpcView: ViewFn = async (contractId, method, args) => {
  if (builtFor !== configVersion()) {
    provider = null;
    builtFor = configVersion();
  }
  provider ??= new JsonRpcProvider({ url: config.justhootRpcUrl });
  return provider.callFunction({ contractId, method, args });
};
let view: ViewFn = rpcView;
/** Tests swap in a mock RPC. */
export const setJusthootView = (v: ViewFn | null) => {
  view = v ?? rpcView;
};

/** Token account the launcher creates for a symbol. */
export const justhootTokenId = (symbol: string, factory = config.justhootFactory) => `${symbol.toLowerCase()}.${factory}`;
export const justhootUrl = (tokenId: string) => `${config.justhootUrlBase}${tokenId}`;

/** Why a Yeetpad idea can't launch on JustHoot, or null. */
export function justhootProblem(idea: Pick<LaunchIdea, "name" | "ticker">): string | null {
  if (!SYMBOL_RE.test(idea.ticker)) return `ticker "${idea.ticker}" is too long for JustHoot (max 10 letters/digits)`;
  if ([...idea.name.trim()].length < 1) return "name is empty";
  return null;
}

/**
 * Icon for the on-chain metadata: the first candidate that is a data:image/ URL of at most `max` chars
 * (the client sends a 128 px webp first, then our SVG), else null (launch without an icon).
 */
export function fitIcon(candidates: (string | null | undefined)[], max = ICON_MAX_CHARS): string | null {
  for (const c of candidates) if (c && c.startsWith("data:image/") && c.length <= max) return c;
  return null;
}

/** JSON served at `reference` (same field names JustHoot's own metadata uses). Bytes are hashed as-is. */
export function referenceJson(idea: Pick<LaunchIdea, "tagline" | "description">, website: string): string {
  return JSON.stringify({ description: idea.tagline, about: idea.description, website });
}

export async function sha256Base64(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let s = "";
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s);
}

/** `launch_meme` args: no first buy, no transfer fee, all fee shares to the creator (JustHoot's own defaults). */
export function buildLaunchArgs(
  idea: Pick<LaunchIdea, "name" | "ticker">,
  icon: string | null,
  ref: { url: string; hash: string } | null,
  quoteTokenId = "wrap.near",
): LaunchMemeArgs {
  return {
    name: [...idea.name.trim()].slice(0, NAME_MAX).join(""),
    symbol: idea.ticker.toUpperCase(),
    icon,
    reference: ref?.url ?? null,
    reference_hash: ref?.hash ?? null,
    quote_token_id: quoteTokenId,
    dev_buy_quote_max: null,
    transfer_fee_pips: 0,
    shares: { token_owner_bps: 10_000, burn_bps: 0, holders_bps: 0 },
  };
}

/** Exact deposit (yocto) and gas for one launch, from the launcher's views. */
export async function quoteJusthoot(args: LaunchMemeArgs, accountId: string | null): Promise<{ deposit: string; gas: string }> {
  const [dep, gas] = await Promise.all([
    view(config.justhootFactory, "get_launch_deposit", { args, account_id: accountId }),
    view(config.justhootFactory, "get_launch_gas", { args }).catch(() => null),
  ]);
  const tgas = gas == null ? FALLBACK_GAS_TGAS : BigInt(gas as string | number);
  return { deposit: BigInt(dep as string).toString(), gas: (tgas * 10n ** 12n).toString() };
}

export interface JusthootStatus {
  enabled: boolean;
  /** Reason the venue can't be used right now, or null. */
  reason: string | null;
  isPublic: boolean | null;
}

/** Flag first (no RPC while off), then `is_public_launch` / `is_whitelisted_creator`. */
export async function justhootStatus(accountId?: string | null): Promise<JusthootStatus> {
  if (!config.justhootEnabled) return { enabled: false, reason: config.justhootDisabledReason, isPublic: null };
  try {
    const isPublic = (await view(config.justhootFactory, "is_public_launch", {})) === true;
    if (isPublic) return { enabled: true, reason: null, isPublic };
    if (accountId && (await view(config.justhootFactory, "is_whitelisted_creator", { account_id: accountId })) === true) {
      return { enabled: true, reason: null, isPublic };
    }
    return { enabled: false, reason: "JustHoot launches are whitelist-only right now (is_public_launch = false).", isPublic };
  } catch (e) {
    return { enabled: false, reason: `couldn't reach JustHoot (${(e as Error).message.slice(0, 80)})`, isPublic: null };
  }
}

export const accountExists = async (accountId: string) => {
  try {
    await view(accountId, "ft_metadata", {});
    return true;
  } catch (e) {
    return !/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(String((e as Error).message ?? e));
  }
};

export interface JusthootLaunchEvent {
  token_id: string;
  creator_id: string;
}
export interface JusthootTxResult {
  launched: JusthootLaunchEvent[];
  /** `launch_rejected` reasons / `launch_failed` (both refund the creator). */
  failures: string[];
}

/** Reads `meme_launched` / `launch_rejected` / `launch_failed` events the launcher logged in a tx's receipts. */
export function parseLaunchLogs(
  receipts: { outcome: { executor_id: string; logs: string[] } }[],
  factory = config.justhootFactory,
): JusthootTxResult {
  const out: JusthootTxResult = { launched: [], failures: [] };
  for (const r of receipts) {
    if (r.outcome.executor_id !== factory) continue;
    for (const l of r.outcome.logs) {
      if (!l.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(l.slice(11));
        if (e.standard !== "hoot_launcher_v2") continue;
        if (e.event === "meme_launched") out.launched.push({ token_id: e.data.token_id, creator_id: e.data.creator_id });
        else if (e.event === "launch_rejected") out.failures.push(`launch rejected: ${e.data?.reason ?? "unknown"} (refunded)`);
        else if (e.event === "launch_failed") out.failures.push("token creation failed (refunded)");
      } catch {}
    }
  }
  return out;
}

export type TxLookup = (txHash: string, signer: string) => Promise<{ signer: string; receipts: { outcome: { executor_id: string; logs: string[] } }[] }>;
const rpcTx: TxLookup = async (txHash, signer) => {
  if (builtFor !== configVersion() || !provider) {
    provider = new JsonRpcProvider({ url: config.justhootRpcUrl });
    builtFor = configVersion();
  }
  const st = (await provider.viewTransactionStatusWithReceipts({ txHash, accountId: signer, waitUntil: "FINAL" } as never)) as unknown as {
    transaction: { signer_id: string };
    receipts_outcome: { outcome: { executor_id: string; logs: string[] } }[];
  };
  return { signer: st.transaction.signer_id, receipts: st.receipts_outcome };
};
let txLookup: TxLookup = rpcTx;
export const setJusthootTxLookup = (t: TxLookup | null) => {
  txLookup = t ?? rpcTx;
};

export async function justhootLaunchesInTx(txHash: string, signer: string): Promise<JusthootTxResult> {
  const t = await txLookup(txHash, signer);
  if (t.signer !== signer) return { launched: [], failures: ["transaction was signed by another account"] };
  return parseLaunchLogs(t.receipts);
}

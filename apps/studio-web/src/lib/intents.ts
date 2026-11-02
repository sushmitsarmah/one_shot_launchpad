/**
 * NEAR Intents (1Click) helpers for the token page widget. Pure and dependency-free (the token page
 * bundle has no zod/React). Quotes go through our API (/api/intents/*), which proxies 1Click.
 */
import type { PreparedCall } from "./wallet";

export interface IntentsToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price?: number;
}
export type IntentsStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";
export const TERMINAL: IntentsStatus[] = ["SUCCESS", "REFUNDED", "FAILED"];
export const STATUS_TEXT: Record<IntentsStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit…",
  KNOWN_DEPOSIT_TX: "Deposit seen, waiting for confirmations…",
  INCOMPLETE_DEPOSIT: "Deposit is less than quoted; it will be refunded unless topped up.",
  PROCESSING: "Swapping…",
  SUCCESS: "Done ✓",
  REFUNDED: "Refunded to your refund address.",
  FAILED: "Failed. Funds are refunded to your refund address.",
};

const CHAIN: Record<string, string> = {
  near: "NEAR", eth: "Ethereum", btc: "Bitcoin", sol: "Solana", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon",
  bsc: "BNB Chain", avax: "Avalanche", gnosis: "Gnosis", ton: "TON", tron: "Tron", sui: "Sui", aptos: "Aptos", doge: "Dogecoin",
  xrp: "XRP Ledger", zec: "Zcash", ltc: "Litecoin", bch: "Bitcoin Cash", stellar: "Stellar", cardano: "Cardano", starknet: "Starknet",
  bera: "Berachain", monad: "Monad", scroll: "Scroll", hypercore: "Hyperliquid",
};
export const chainName = (b: string) => CHAIN[b] ?? b.toUpperCase();
const POPULAR = ["USDC", "USDT", "BTC", "ETH", "SOL", "wNEAR", "NEAR"];

/** Pay-with options, popular assets first, de-duplicated by asset id. */
export function payOptions(tokens: IntentsToken[]) {
  const seen = new Set<string>();
  const rank = (t: IntentsToken) => {
    const i = POPULAR.indexOf(t.symbol);
    return i < 0 ? POPULAR.length : i;
  };
  return tokens
    .filter((t) => !seen.has(t.assetId) && seen.add(t.assetId))
    .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol) || chainName(a.blockchain).localeCompare(chainName(b.blockchain)))
    .map((t) => ({ ...t, label: `${t.symbol} · ${chainName(t.blockchain)}` }));
}

/** "1.5" with 6 decimals -> 1500000n. Null if not a positive number or too many decimals. BigInt only. */
export function parseUnits(s: string, decimals: number): bigint | null {
  const v = s.trim();
  if (!/^\d*(\.\d*)?$/.test(v) || v === "" || v === ".") return null;
  const [w, f = ""] = v.split(".");
  if (f.length > decimals) return null;
  const n = BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  return n > 0n ? n : null;
}

/** Base units -> readable, rounded down to `dp` decimals. */
export function formatUnits(v: bigint, decimals: number, dp = 6): string {
  const base = 10n ** BigInt(decimals);
  const cut = Math.min(dp, decimals);
  const frac = ((v % base) / 10n ** BigInt(decimals - cut)).toString().padStart(cut, "0").replace(/0+$/, "");
  return `${(v / base).toString()}${frac ? `.${frac}` : ""}`;
}

/**
 * A NEAR mainnet account: name.near (or another mainnet top-level), 64-hex implicit or 0x EVM implicit; never
 * `.testnet`. Mirrors isNearMainnetAccount in @osl/schema (copied: this bundle stays zod-free).
 */
export function isMainnetAccount(a: string): boolean {
  if (typeof a !== "string" || a.length < 2 || a.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(a) || /^0x[0-9a-f]{40}$/.test(a)) return true;
  return !/\.(testnet|betanet)$/.test(a) && /^(([a-z\d]+[-_])*[a-z\d]+\.)+([a-z\d]+[-_])*[a-z\d]+$/.test(a);
}

/** Minimum output for a Rhea swap: quoted × (1 − bps), rounded down. */
export const minOut = (quoted: bigint, bps: number) => (quoted * BigInt(10_000 - bps)) / 10_000n;

export const SWAP_GAS = (180n * 10n ** 12n).toString();
export const REGISTER_DEPOSIT = (125n * 10n ** 19n).toString(); // 0.00125 NEAR

/**
 * Wallet calls for "wNEAR -> token" on Rhea DCL: register the visitor on the token (and on wNEAR) if needed,
 * wrap any NEAR shortfall, then ft_transfer_call wNEAR to DCL with a Swap message (output goes to the sender).
 */
export function rheaBuyCalls(o: {
  dcl: string;
  wnear: string;
  poolId: string;
  token: string;
  amountIn: bigint;
  minAmountOut: bigint;
  wrapNear: bigint;
  registerToken: boolean;
  registerWnear: boolean;
}): PreparedCall[] {
  const calls: PreparedCall[] = [];
  const reg = (receiverId: string): PreparedCall => ({ ticker: "", receiverId, methodName: "storage_deposit", args: { registration_only: true }, gas: (10n * 10n ** 12n).toString(), deposit: REGISTER_DEPOSIT });
  if (o.registerToken) calls.push(reg(o.token));
  if (o.registerWnear) calls.push(reg(o.wnear));
  if (o.wrapNear > 0n) calls.push({ ticker: "", receiverId: o.wnear, methodName: "near_deposit", args: {}, gas: (10n * 10n ** 12n).toString(), deposit: o.wrapNear.toString() });
  calls.push({
    ticker: "",
    receiverId: o.wnear,
    methodName: "ft_transfer_call",
    args: {
      receiver_id: o.dcl,
      amount: o.amountIn.toString(),
      msg: JSON.stringify({ Swap: { pool_ids: [o.poolId], output_token: o.token, min_output_amount: o.minAmountOut.toString() } }),
    },
    gas: SWAP_GAS,
    deposit: "1",
  });
  return calls;
}

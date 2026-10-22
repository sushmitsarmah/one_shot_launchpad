import type { PreparedCall } from "./wallet";

/** A Rhea DCL v2 position as returned by `list_liquidities` / `get_liquidity`. */
export interface DclPosition {
  lpt_id: string;
  owner_id: string;
  pool_id: string;
  amount: string;
  mft_id?: string | null;
}

/** Gas per remove_liquidity tx (it then withdraws both assets to the wallet in callbacks; ~15 Tgas used). */
export const REMOVE_GAS = 150n * 10n ** 12n;
/** Worst-case fee per tx at 0.1 Ngas/gas (unused gas is refunded); for the confirm dialog. */
export const REMOVE_MAX_FEE_NEAR = Number(REMOVE_GAS) * 1e8 / 1e24;

/**
 * Positions of `owner` that can be pulled for `tokenId`: pool contains the token, liquidity > 0 and not
 * staked in a farm (`mft_id` set: DCL refuses to remove those until unstaked). Gone/empty ones are skipped.
 */
export function removablePositions(all: DclPosition[], tokenId: string, owner: string) {
  const mine = all.filter((p) => p.owner_id === owner && p.pool_id.split("|").includes(tokenId));
  return {
    removable: mine.filter((p) => BigInt(p.amount || "0") > 0n && !p.mft_id),
    farmed: mine.filter((p) => BigInt(p.amount || "0") > 0n && !!p.mft_id),
  };
}

/** Slippage for the liquidity pull, in percent. Presets offered in the confirm dialog; custom allowed within bounds. */
export const SLIPPAGE_PRESETS = [0.5, 1, 3] as const;
export const SLIPPAGE_DEFAULT = 1;
export const SLIPPAGE_MIN = 0.01;
export const SLIPPAGE_MAX = 20;

/** Percent -> basis points (integer), or null when out of [SLIPPAGE_MIN, SLIPPAGE_MAX] or not a number. */
export function slippageBps(pct: number): number | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < SLIPPAGE_MIN || pct > SLIPPAGE_MAX) return null;
  return Math.round(pct * 100);
}

/**
 * Minimum acceptable amount: expected × (1 − bps/10000), rounded DOWN, in token base units (BigInt only).
 * Zero expected -> zero minimum. Throws on negative amounts or bps outside 1..2000.
 */
export function minAmount(expected: bigint | string, bps: number): bigint {
  const e = typeof expected === "bigint" ? expected : BigInt(expected);
  if (e < 0n) throw new Error("negative amount");
  if (!Number.isInteger(bps) || bps < 1 || bps > SLIPPAGE_MAX * 100) throw new Error(`slippage out of range: ${bps} bps`);
  return (e * BigInt(10_000 - bps)) / 10_000n;
}

/** What a position would return right now (token_x / token_y of its pool, in base units), or why it couldn't be quoted. */
export type PositionQuote = { ok: true; x: bigint; y: bigint } | { ok: false; error: string };

export const poolTokens = (p: DclPosition) => {
  const [x, y] = p.pool_id.split("|");
  return { x, y };
};

/**
 * Quotes a full withdrawal with DCL v2's own view `predict_remove_liquidity({lpt_id, amount}) -> [amount_x, amount_y]`
 * (same math remove_liquidity runs, at the current pool price). Never falls back to zero: failures come back as {ok:false}.
 */
export async function quotePosition(view: (c: string, m: string, a: object) => Promise<unknown>, dcl: string, p: DclPosition): Promise<PositionQuote> {
  try {
    const r = await view(dcl, "predict_remove_liquidity", { lpt_id: p.lpt_id, amount: p.amount });
    if (!Array.isArray(r) || r.length !== 2 || !r.every((v) => typeof v === "string" && /^\d+$/.test(v))) throw new Error("unexpected quote format");
    return { ok: true, x: BigInt(r[0]), y: BigInt(r[1]) };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

/** Minimums to send: from a quote and slippage, or explicitly unprotected (0/0, only when the user chose it). */
export type Mins = { x: bigint; y: bigint };
export const minsFor = (q: { x: bigint; y: bigint }, bps: number): Mins => ({ x: minAmount(q.x, bps), y: minAmount(q.y, bps) });
export const UNPROTECTED: Mins = { x: 0n, y: 0n };

/** True when a DCL failure message is the slippage check (min_amount_x/y not met). */
export const isSlippageError = (msg: string) => /slippage|E204|min_amount/i.test(msg);

/**
 * The call the wallet signs: DCL `remove_liquidity` for the whole position with min_amount_x/y (no deposit; DCL rejects one).
 * DCL then sends both tokens straight to the owner's wallet (and unwraps wNEAR), so no separate withdraw step.
 */
export function removeLiquidityCall(dcl: string, p: DclPosition, label: string, mins: Mins): PreparedCall {
  return {
    ticker: label,
    receiverId: dcl,
    methodName: "remove_liquidity",
    args: { lpt_id: p.lpt_id, amount: p.amount, min_amount_x: mins.x.toString(), min_amount_y: mins.y.toString() },
    gas: REMOVE_GAS.toString(),
    deposit: "0",
  };
}

/** Base units -> human string with up to `dp` decimals, rounded down (BigInt only). */
export function fmtUnits(v: bigint, decimals: number, dp = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const cut = Math.min(dp, decimals);
  const frac = ((v % base) / 10n ** BigInt(decimals - cut)).toString().padStart(cut, "0").replace(/0+$/, "");
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${w}.${frac}` : v > 0n && whole === 0n ? `<${(1 / 10 ** cut).toFixed(cut)}` : w;
}

/** What the user chose for one position in the confirm dialog. `protect` = mins from a fresh quote × (1 − bps). */
export type PullItem = { ticker: string; p: DclPosition; mode: "protect"; bps: number } | { ticker: string; p: DclPosition; mode: "unprotected" };

export type PullState = "withdrawn" | "slippage" | "failed" | "unquoted" | "not-signed";
export interface PullResult {
  ticker: string;
  p: DclPosition;
  state: PullState;
  txHash?: string;
  note?: string;
}

/**
 * Outcome of one position after signing, from the chain: gone/empty -> withdrawn; still there -> slippage if the
 * failure says so (DCL "E204: slippage error"), else failed, or not-signed when the wallet never sent it.
 */
export function classifyPull(after: DclPosition | null, sent: boolean, failure: string | null): PullState {
  if (!after || BigInt(after.amount || "0") === 0n) return "withdrawn";
  if (!sent) return "not-signed";
  return failure && isSlippageError(failure) ? "slippage" : "failed";
}

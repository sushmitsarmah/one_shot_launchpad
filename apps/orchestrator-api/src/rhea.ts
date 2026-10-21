/**
 * Rhea direct listing math + vault calls.
 *
 * Price: opening price P (NEAR per whole token) = FDV_near / supply_whole.
 * DCL price at point p is 1.0001^p, in raw units of token_y per raw token_x.
 *  - token sorts before wNEAR -> token is X: raw price = P * 10^(24 - decimals), p = log_1.0001(raw).
 *    One-sided X range sits above the price: [init + 200, init + 500_000] (clamped to 800_000).
 *  - token sorts after wNEAR -> token is Y: raw price (wNEAR per token inverted) = 1 / that, p = -log(..).
 *    One-sided Y range sits at/below the price: [init - 500_000, init].
 * Points are floored to the fee-10000 grid (multiples of 200). Example: 1000 NEAR FDV, 1B supply,
 * 18 decimals -> P = 1e-6 NEAR, raw = 1e-6 * 1e6 = 1 -> p = 0.
 */
import { config } from "./config";

export const POINT_DELTA = 200;
export const MAX_POINT = 800_000;
export const RANGE = 500_000;
const NEAR = 10n ** 24n;
export const TOKEN_STORAGE = 1_250_000_000_000_000_000_000n;
export const DCL_MIN_STORAGE = 5n * 10n ** 23n; // 0.5 NEAR storage_balance_bounds.min

const floorTo = (x: number, d: number) => Math.floor(x / d) * d;
const clamp = (x: number) => Math.max(-MAX_POINT, Math.min(MAX_POINT, x));

/** One-sided range for an existing pool at `current` (re-listing). */
export function pointsForExisting(tokenIsX: boolean, current: number) {
  if (tokenIsX) {
    const left = Math.ceil((current + 1) / POINT_DELTA) * POINT_DELTA;
    return { init: current, left, right: clamp(left + RANGE - POINT_DELTA) };
  }
  const right = Math.floor(current / POINT_DELTA) * POINT_DELTA;
  return { init: current, left: clamp(right - RANGE), right };
}

export interface ListParams {
  pool_amount: string;
  init_point: number;
  left_point: number;
  right_point: number;
  pool_deposit: string;
  creator_dcl_storage: string;
  skip_create_pool?: boolean;
}

export function computePoints(tokenId: string, wnear: string, fdvNear: number, supply: bigint, decimals: number) {
  const supplyWhole = Number(supply) / 10 ** decimals;
  const price = fdvNear / supplyWhole; // NEAR per token
  const tokenIsX = tokenId < wnear;
  const rawLog = Math.log(price) + (24 - decimals) * Math.log(10);
  let p = rawLog / Math.log(1.0001);
  if (!tokenIsX) p = -p;
  // Keep room for the range inside ±800k.
  const init = 0 + Math.max(-MAX_POINT + RANGE, Math.min(MAX_POINT - RANGE, floorTo(Math.round(p), POINT_DELTA)));
  return tokenIsX
    ? { tokenIsX, init, left: init + POINT_DELTA, right: clamp(init + RANGE) }
    : { tokenIsX, init, left: clamp(init - RANGE), right: init };
}

/** Back out the opening FDV a point implies (for display). */
export function fdvAtPoint(tokenIsX: boolean, point: number, supply: bigint, decimals: number): number {
  const raw = Math.pow(1.0001, tokenIsX ? point : -point);
  return (raw / 10 ** (24 - decimals)) * (Number(supply) / 10 ** decimals);
}

export function buildListParams(opts: {
  tokenId: string;
  supply: bigint;
  decimals: number;
  fdvNear: number;
  creatorPct: number;
  creatorDclStorage: bigint;
  /** Tokens the vault holds for this listing (defaults to the supply); the pool gets (100-creatorPct)% of it. */
  holding?: bigint;
  /** Current point of an existing pool (re-listing); the FDV is then ignored. */
  existingPoint?: number | null;
}): ListParams & { tokenIsX: boolean } {
  const fresh = computePoints(opts.tokenId, config.wnearContract, opts.fdvNear, opts.supply, opts.decimals);
  const existing = opts.existingPoint ?? null;
  const pts = existing === null ? fresh : { tokenIsX: fresh.tokenIsX, ...pointsForExisting(fresh.tokenIsX, existing) };
  const creatorBps = BigInt(Math.round(opts.creatorPct * 100));
  const pool = ((opts.holding ?? opts.supply) * (10_000n - creatorBps)) / 10_000n;
  return {
    tokenIsX: pts.tokenIsX,
    pool_amount: pool.toString(),
    init_point: pts.init,
    left_point: pts.left,
    right_point: pts.right,
    pool_deposit: config.rheaPoolDepositYocto,
    creator_dcl_storage: opts.creatorDclStorage.toString(),
    ...(existing !== null ? { skip_create_pool: true } : {}),
  };
}

export const poolIdFor = (tokenId: string) =>
  tokenId < config.wnearContract ? `${tokenId}|${config.wnearContract}|10000` : `${config.wnearContract}|${tokenId}|10000`;

/** NEAR a listing costs on top of the launch: pool + creator DCL storage (first time) + 2 registrations. */
export function listingCost(creatorDclStorage: bigint, poolExists = false): bigint {
  return (poolExists ? 0n : BigInt(config.rheaPoolDepositYocto)) + creatorDclStorage + 2n * TOKEN_STORAGE;
}

export const rheaPoolUrl = (poolId: string) => `${config.rheaPoolUrlBase}${poolId.replace(/\|/g, "@")}`;
export const nearFmt = (y: bigint) => Number(y) / Number(NEAR);

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

/**
 * The call the wallet signs: DCL `remove_liquidity` for the whole position (no deposit; DCL rejects one).
 * DCL then sends both tokens straight to the owner's wallet (and unwraps wNEAR), so no separate withdraw step.
 */
export function removeLiquidityCall(dcl: string, p: DclPosition, label: string): PreparedCall {
  return {
    ticker: label,
    receiverId: dcl,
    methodName: "remove_liquidity",
    args: { lpt_id: p.lpt_id, amount: p.amount, min_amount_x: "0", min_amount_y: "0" },
    gas: REMOVE_GAS.toString(),
    deposit: "0",
  };
}

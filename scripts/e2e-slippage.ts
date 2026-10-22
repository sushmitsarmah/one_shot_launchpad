// Live testnet check of the slippage-protected liquidity pull, signed with the e2e key (no browser wallet).
// Usage: LPT=<lpt_id> [SLIPPAGE=1] bun e2e-slippage.ts
//   1. quotes the position with DCL predict_remove_liquidity, 2. sends remove_liquidity with mins = expected × 2
//   (must revert, position untouched), 3. sends it with mins = expected × (1 − slippage) (must succeed).
// Uses the same helpers (quotePosition, minsFor, removeLiquidityCall) the Studio uses.
import { Account, JsonRpcProvider, actions, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { isSlippageError, minsFor, poolTokens, quotePosition, removeLiquidityCall, slippageBps, type DclPosition, type Mins } from "../apps/studio-web/src/lib/dcl";

const DCL = process.env.DCL_CONTRACT ?? "dclv2.ref-dev.testnet";
const k = JSON.parse(readFileSync(process.env.E2E_KEY_FILE ?? `${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8"));
const who: string = k.account_id;
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const acct = new Account(who, provider, k.private_key as KeyPairString);
const view = (c: string, m: string, a: object) => provider.callFunction({ contractId: c, method: m, args: a as Record<string, unknown> });
const fmt = (y: bigint) => (Number(y) / 1e24).toFixed(5);
const near = async () => BigInt((await provider.viewAccount({ accountId: who })).amount);
const bal = async (t: string) => BigInt((await view(t, "ft_balance_of", { account_id: who })) as string);
const getLp = async (id: string) => (await view(DCL, "get_liquidity", { lpt_id: id }).catch(() => null)) as DclPosition | null;

const id = process.env.LPT!;
const bps = slippageBps(Number(process.env.SLIPPAGE ?? 1))!;
const lp = await getLp(id);
if (!lp || lp.owner_id !== who || BigInt(lp.amount) === 0n) throw new Error(`position ${id}: gone, empty or not ours`);
const q = await quotePosition(view, DCL, lp);
if (!q.ok) throw new Error(`couldn't quote: ${q.error}`);
const { x: tx_, y: ty } = poolTokens(lp);
const mins = minsFor(q, bps);
console.log(`position ${id}\n  expected ${tx_}: ${q.x} · ${ty}: ${q.y}\n  mins @ ${bps / 100}%: ${mins.x} · ${mins.y}`);

const send = async (m: Mins) => {
  const c = removeLiquidityCall(DCL, lp, "lp", m);
  const r: any = await acct.signAndSendTransaction({ receiverId: c.receiverId, actions: [actions.functionCall(c.methodName, c.args, BigInt(c.gas), BigInt(c.deposit))], throwOnFailure: false } as any).catch((e: any) => ({ thrown: e }));
  if (r.thrown) return { hash: r.thrown?.context?.transactionHash ?? "?", err: String(r.thrown?.message ?? r.thrown) };
  const f = r.status?.Failure ?? r.receipts_outcome.find((o: any) => o.outcome.status.Failure)?.outcome.status.Failure;
  return { hash: r.transaction.hash as string, err: f ? JSON.stringify(f) : null };
};
const n0 = await near();
const b0 = { x: await bal(tx_).catch(() => 0n), y: await bal(ty).catch(() => 0n) };

const bad = await send({ x: q.x * 2n, y: q.y * 2n });
const still = await getLp(id);
console.log(`impossible mins (expected × 2): tx https://testnet.nearblocks.io/txns/${bad.hash}\n  reverted: ${!!bad.err} · slippage error: ${!!bad.err && isSlippageError(bad.err)} · position untouched: ${still?.amount === lp.amount}\n  error: ${bad.err?.slice(0, 300)}`);

const good = await send(mins);
const after = await getLp(id);
const b1 = { x: await bal(tx_).catch(() => 0n), y: await bal(ty).catch(() => 0n) };
console.log(`computed mins: tx https://testnet.nearblocks.io/txns/${good.hash}\n  ok: ${!good.err} · position after: ${after ? `amount ${after.amount}` : "gone"}\n  received ${tx_}: ${b1.x - b0.x} (min ${mins.x}) · ${ty}: ${b1.y - b0.y} (min ${mins.y})${good.err ? `\n  error: ${good.err.slice(0, 300)}` : ""}`);
await new Promise((r) => setTimeout(r, 5000));
console.log(`wallet NEAR delta ${fmt((await near()) - n0)} (wNEAR received is counted above, not here)`);

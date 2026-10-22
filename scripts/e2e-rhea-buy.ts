// Live testnet check of the token page's "buy" step 2: wNEAR -> token on Rhea DCL, signed with the e2e key,
// using exactly the calls the widget builds (rheaBuyCalls). Usage: TOKEN=<token id> [AMOUNT_NEAR=0.005] bun e2e-rhea-buy.ts
import { Account, JsonRpcProvider, actions, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { minOut, rheaBuyCalls } from "../apps/studio-web/src/lib/intents";

const DCL = "dclv2.ref-dev.testnet", WNEAR = "wrap.testnet";
const k = JSON.parse(readFileSync(`${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8"));
const who: string = k.account_id;
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const acct = new Account(who, provider, k.private_key as KeyPairString);
const view = (c: string, m: string, a: object) => provider.callFunction({ contractId: c, method: m, args: a as Record<string, unknown> }) as Promise<any>;
const token = process.env.TOKEN!;
const poolId = [token, WNEAR].sort().join("|") + "|10000";
const amountIn = BigInt(Math.round(Number(process.env.AMOUNT_NEAR ?? "0.005") * 1e6)) * 10n ** 18n;
const q = await view(DCL, "quote", { pool_ids: [poolId], input_token: WNEAR, output_token: token, input_amount: amountIn.toString(), tag: null });
const quoted = BigInt(q.amount);
const wbal = BigInt(await view(WNEAR, "ft_balance_of", { account_id: who }));
const calls = rheaBuyCalls({
  dcl: DCL, wnear: WNEAR, poolId, token, amountIn, minAmountOut: minOut(quoted, 100),
  wrapNear: wbal >= amountIn ? 0n : amountIn - wbal,
  registerToken: !(await view(token, "storage_balance_of", { account_id: who })),
  registerWnear: !(await view(WNEAR, "storage_balance_of", { account_id: who })),
});
const t0 = BigInt(await view(token, "ft_balance_of", { account_id: who }));
const n0 = BigInt((await provider.viewAccount({ accountId: who })).amount);
console.log(`pool ${poolId}\n  quote ${amountIn} yocto wNEAR -> ${quoted} (min ${minOut(quoted, 100)}); calls: ${calls.map((c) => c.methodName).join(", ")}`);
for (const c of calls) {
  const r: any = await acct.signAndSendTransaction({ receiverId: c.receiverId, actions: [actions.functionCall(c.methodName, c.args, BigInt(c.gas), BigInt(c.deposit))] });
  const f = r.receipts_outcome.find((o: any) => o.outcome.status.Failure);
  console.log(`  ${c.methodName}: https://testnet.nearblocks.io/txns/${r.transaction.hash}${f ? ` FAILED ${JSON.stringify(f.outcome.status.Failure).slice(0, 200)}` : ""}`);
}
const t1 = BigInt(await view(token, "ft_balance_of", { account_id: who }));
console.log(`  received ${t1 - t0} (quoted ${quoted}) · ok ${t1 - t0 >= minOut(quoted, 100)}`);
await new Promise((r) => setTimeout(r, 3000));
console.log(`  wallet NEAR delta ${(Number(BigInt((await provider.viewAccount({ accountId: who })).amount) - n0) / 1e24).toFixed(5)}`);

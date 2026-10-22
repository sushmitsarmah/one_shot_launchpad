import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
const k = JSON.parse(readFileSync(`${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8"));
const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const a = new Account(k.account_id, p, k.private_key as KeyPairString);
const DCL = "dclv2.ref-dev.testnet";
const lpt = process.argv[2];
const lp = (await p.callFunction({ contractId: DCL, method: "get_liquidity", args: { lpt_id: lpt } })) as any;
console.log("before", lp?.amount, lp?.mft_id, lp?.v_liquidity);
const w0 = BigInt((await p.viewAccount({ accountId: k.account_id })).amount);
const r = await a.callFunctionRaw({ contractId: DCL, methodName: "remove_liquidity", args: { lpt_id: lpt, amount: lp.amount, min_amount_x: "0", min_amount_y: "0" }, gas: 150n * 10n ** 12n, deposit: BigInt(process.argv[3] ?? "1") });
const st: any = r.status;
console.log("tx", r.transaction.hash, JSON.stringify(st).slice(0, 300));
for (const o of r.receipts_outcome) { if (o.outcome.logs.length) console.log(o.outcome.executor_id, o.outcome.logs.join(" | ").slice(0, 400)); const f = (o.outcome.status as any).Failure; if (f) console.log("FAIL", o.outcome.executor_id, JSON.stringify(f).slice(0, 300)); }
const after = await p.callFunction({ contractId: DCL, method: "get_liquidity", args: { lpt_id: lpt } }).catch((e) => `err ${String(e).slice(0, 100)}`);
console.log("after", JSON.stringify(after)?.slice(0, 200));
const w1 = BigInt((await p.viewAccount({ accountId: k.account_id })).amount);
console.log("wallet delta", (Number(w1 - w0) / 1e24).toFixed(5));

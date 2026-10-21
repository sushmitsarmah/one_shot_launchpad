// Live testnet check of the launch venues through the deployed API, signed with a test account key
// (no browser wallet). Usage: E2E_KEY_FILE=~/.secrets/near_<acct>.json bun e2e-venues.ts [rhea] [nearly] [nearly2]
// Spends real testnet NEAR: ~2.35 credit per Rhea launch, ~0.2 wallet per Nearly launch.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions as actionCreators, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";

const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = process.env.VAULT_CONTRACT ?? "launch-vault.osl-launchpad-5786.testnet";
const DCL = process.env.DCL_CONTRACT ?? "dclv2.ref-dev.testnet";
const WNEAR = process.env.WNEAR_CONTRACT ?? "wrap.testnet";
const EXPLORER = "https://testnet.nearblocks.io/txns/";
const keyFile = JSON.parse(readFileSync(process.env.E2E_KEY_FILE!, "utf8")) as { account_id: string; private_key: string };
const who = keyFile.account_id;
const kp = KeyPair.fromString(keyFile.private_key as KeyPairString);
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const acct = new Account(who, provider, keyFile.private_key as KeyPairString);
const steps = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["rhea", "nearly", "nearly2"]);
const NEAR = 10n ** 24n;
const fmt = (y: bigint | string) => (Number(BigInt(y)) / 1e24).toFixed(5);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const view = (contractId: string, method: string, args: Record<string, unknown>) => provider.callFunction({ contractId, method, args }) as Promise<any>;
const balance = async () => BigInt((await provider.viewAccount({ accountId: who })).amount);

async function session(): Promise<string> {
  const message = `Sign in to Yeetpad\naccount: ${who}\nissued: ${new Date().toISOString()}`;
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const signed = await new KeyPairSigner(kp).signNep413Message(who, { message, recipient: VAULT, nonce });
  const r = await fetch(`${API}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: who, publicKey: kp.getPublicKey().toString(), signature: b64(signed.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`sign-in: ${JSON.stringify(j)}`);
  return j.token;
}
let token = "";
async function api(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok && r.status !== 502) throw new Error(`${path} ${r.status}: ${JSON.stringify(j)}`);
  return j;
}
const stamp = Date.now().toString(36).slice(-5);
const idea = (ticker: string, name: string) => ({
  name,
  ticker,
  tagline: "Yeetpad venue e2e test token",
  description: "Testnet token created by the Yeetpad venue end-to-end check. Not for trading.",
  colors: { primary: "#ff3d8b", secondary: "#2b2bff", accent: "#ffd23f", background: "#fff6e9", text: "#111111" },
});

token = await session();
console.log(`signed in as ${who}; wallet ${fmt(await balance())} NEAR`);

if (steps.has("rhea")) {
  const ideas = [idea(`yr${stamp}`, `Yeet Rhea ${stamp}`)];
  const q = await api("/api/quote", { ideas, listOn: "rhea" });
  console.log("rhea quote:", JSON.stringify(q.items[0].parts), "total", fmt(q.total), "init_point", q.rhea?.initPoint);
  const credit = BigInt(await view(VAULT, "get_balance", { account_id: who }));
  const need = BigInt(q.total) + NEAR / 100n;
  if (credit < need) {
    const top = need - credit;
    const r = await acct.callFunctionRaw({ contractId: VAULT, methodName: "deposit_credits", args: {}, deposit: top, gas: 30n * 10n ** 12n });
    console.log(`topped up credit by ${fmt(top)}: ${EXPLORER}${r.transaction.hash}`);
  }
  const before = BigInt(await view(VAULT, "get_balance", { account_id: who }));
  const t0 = Date.now();
  const res = await api("/api/launch", { idea: ideas[0], listOn: "rhea" });
  const after = BigInt(await view(VAULT, "get_balance", { account_id: who }));
  console.log(`rhea launch ${((Date.now() - t0) / 1000).toFixed(1)}s, credit spent ${fmt(before - after)}`);
  console.log("  launch tx:", res.explorerUrl);
  await verifyRhea(res.tokenId, res.listing);
}

async function verifyRhea(tokenId: string, listing: any) {
  console.log("  listing:", JSON.stringify(listing));
  if (listing?.txHash) console.log("  listing tx:", EXPLORER + listing.txHash);
  const pool = listing?.poolId;
  if (!pool) return;
  const p = await view(DCL, "get_pool", { pool_id: pool });
  console.log("  get_pool:", JSON.stringify({ current_point: p?.current_point, liquidity: p?.liquidity, liquidity_x: p?.liquidity_x, total_x: p?.total_x, total_y: p?.total_y, state: p?.state }));
  const mine = (await view(DCL, "list_liquidities", { account_id: who })) as any[];
  for (const l of mine.filter((x) => x.pool_id === pool)) console.log("  creator position:", JSON.stringify({ lpt_id: l.lpt_id, owner_id: l.owner_id, amount: l.amount, left: l.left_point, right: l.right_point }));
  const sw = await view(DCL, "quote", { pool_ids: [pool], input_token: WNEAR, output_token: tokenId, input_amount: (NEAR / 100n).toString(), tag: null });
  console.log(`  quote 0.01 wNEAR -> token:`, JSON.stringify(sw));
  console.log(`  creator token balance ${await view(tokenId, "ft_balance_of", { account_id: who })}, vault ${await view(tokenId, "ft_balance_of", { account_id: VAULT })}; held:`, JSON.stringify(await view(VAULT, "get_held", { token_id: tokenId })));
}

// Re-list a token the creator already holds (e.g. after a failed listing): send to vault, then list.
if (process.env.RELIST) {
  const tokenId = process.env.RELIST;
  const bal = BigInt(await view(tokenId, "ft_balance_of", { account_id: who }));
  const cost = 25n * 10n ** 21n;
  const credit = BigInt(await view(VAULT, "get_balance", { account_id: who }));
  if (credit < cost) {
    const r = await acct.callFunctionRaw({ contractId: VAULT, methodName: "deposit_credits", args: {}, deposit: cost - credit, gas: 30n * 10n ** 12n });
    console.log(`topped up credit by ${fmt(cost - credit)}: ${EXPLORER}${r.transaction.hash}`);
  }
  const t = await acct.callFunctionRaw({ contractId: tokenId, methodName: "ft_transfer_call", args: { receiver_id: VAULT, amount: bal.toString(), msg: "list_on_rhea" }, deposit: 1n, gas: 50n * 10n ** 12n });
  console.log(`sent ${bal} to vault for listing: ${EXPLORER}${t.transaction.hash}`);
  const before = BigInt(await view(VAULT, "get_balance", { account_id: who }));
  const res = await api("/api/list/rhea", { tokenId });
  console.log(`relist credit spent ${fmt(before - BigInt(await view(VAULT, "get_balance", { account_id: who })))}`);
  await verifyRhea(tokenId, res.listing);
}

async function nearly(n: number) {
  const ideas = Array.from({ length: n }, (_, i) => idea(`yn${stamp}${n}${i}`, `Yeet Nearly ${stamp} ${n}${i}`));
  const q = await api("/api/quote", { ideas, listOn: "nearly" });
  console.log(`nearly x${n} quote total ${fmt(q.total)}`, q.items.map((x: any) => fmt(x.total)).join(", "));
  const prep = await api("/api/nearly/prepare", { ideas });
  const w0 = await balance();
  // Same shape signAndSendTransactions gets in the browser: one tx per launch (chunk = prep.chunk).
  const signed: { ticker: string; txHash: string }[] = [];
  for (let i = 0; i < prep.txs.length; i += prep.chunk) {
    const part = prep.txs.slice(i, i + prep.chunk);
    const outs = await Promise.all(
      part.map(async (t: any, k: number) => {
        await new Promise((r) => setTimeout(r, k * 1500)); // distinct nonces
        return acct.signAndSendTransaction({
          receiverId: t.receiverId,
          actions: [actionCreators.functionCall(t.methodName, t.args, BigInt(t.gas), BigInt(t.deposit))],
        });
      }),
    );
    outs.forEach((o: any, k: number) => signed.push({ ticker: part[k].ticker, txHash: o.transaction.hash }));
  }
  const w1 = await balance();
  signed.forEach((s) => console.log(`  ${s.ticker}: ${EXPLORER}${s.txHash}`));
  console.log(`  wallet spent ${fmt(w0 - w1)} NEAR (incl. gas) for ${n}`);
  const fin = await api("/api/nearly/finalize", { items: signed });
  for (const r of fin.results) console.log("  finalize:", JSON.stringify({ ticker: r.ticker, ok: r.ok, tokenId: r.tokenId, siteUrl: r.siteUrl, pool: r.listing?.poolId, error: r.error }));
  for (const r of fin.results.filter((x: any) => x.ok)) {
    const l = await view(prep.factory, "get_launch_by_token", { token: r.tokenId }).catch(() => null);
    console.log(`  nearly record ${r.tokenId}: step ${l?.step} creator ${l?.creator} website ${l?.links?.website}`);
  }
}
if (steps.has("nearly")) await nearly(1);
if (steps.has("nearly2")) await nearly(2);

const mine = await (await fetch(`${API}/api/launches/${who}`)).json();
console.log("my launches (top 5):", mine.launches.slice(0, 5).map((l: any) => `${l.ticker}:${l.venue}:${l.venueUrl ?? "-"}`).join(" | "));
console.log(`wallet now ${fmt(await balance())} NEAR, credit ${fmt(await view(VAULT, "get_balance", { account_id: who }))}`);

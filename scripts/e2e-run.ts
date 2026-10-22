// Live testnet check of a chunked Studio run (same helpers the Studio uses): generate N ideas as MAX_BATCH
// requests (3 in flight, retries, de-dupe), then launch them with venue None in MAX_BATCH chunks, one after another.
// Usage: N=12 bun e2e-run.ts   (E2E_KEY_FILE defaults to the regression admin/creator key)
// Spends testnet credit: 0.01 per idea + the factory deposit (~0.076) per token, plus relayer gas.
import { JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { MAX_BATCH, chunk, chunkSizes, clampRun, dedupeIdeas, pool, type LaunchIdea } from "../packages/schema/src/index";

const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = process.env.VAULT_CONTRACT ?? "launch-vault.osl-launchpad-5786.testnet";
const FACTORY = process.env.FT_FACTORY_CONTRACT ?? "ft-factory.osl-launchpad-5786.testnet";
const RELAYER = process.env.RELAYER_ACCOUNT_ID ?? "osl-launchpad-5786.testnet";
const N = clampRun(process.env.N ?? 12);
const MAX_SPEND = BigInt(Math.round(Number(process.env.MAX_SPEND_NEAR ?? "1.2") * 1e6)) * 10n ** 18n;
const k = JSON.parse(readFileSync(process.env.E2E_KEY_FILE ?? `${process.env.HOME}/.secrets/near_osl-e2e-mvhxupmb.testnet.json`, "utf8")) as { account_id: string; private_key: string };
const who = k.account_id;
const kp = KeyPair.fromString(k.private_key as KeyPairString);
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const fmt = (y: bigint) => (Number(y) / 1e24).toFixed(5);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const credit = async () => BigInt((await provider.callFunction({ contractId: VAULT, method: "get_balance", args: { account_id: who } })) as string);
const wallet = async (a: string) => BigInt((await provider.viewAccount({ accountId: a })).amount);

const message = `Sign in to Yeetpad\naccount: ${who}\nissued: ${new Date().toISOString()}`;
const nonce = crypto.getRandomValues(new Uint8Array(32));
const sig = await new KeyPairSigner(kp).signNep413Message(who, { message, recipient: VAULT, nonce });
const sr = await fetch(`${API}/api/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: who, publicKey: kp.getPublicKey().toString(), signature: b64(sig.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }) });
const token = ((await sr.json()) as { token: string }).token;
if (!sr.ok || !token) throw new Error(`sign-in failed: ${sr.status}`);
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw Object.assign(new Error(`${path} ${r.status}: ${j.error ?? ""}`), { noRetry: r.status >= 400 && r.status < 500, body: j, status: r.status });
  return j;
};

const deposit = BigInt((await provider.callFunction({ contractId: FACTORY, method: "get_required_deposit", args: {} })) as string);
const est = 10n ** 22n * BigInt(N) + deposit * BigInt(N);
const c0 = await credit();
const r0 = await wallet(RELAYER);
console.log(`account ${who}: credit ${fmt(c0)} NEAR; run of ${N} ≈ ${fmt(est)} NEAR (deposit ${fmt(deposit)}/token)`);
if (est > MAX_SPEND) throw new Error(`estimate ${fmt(est)} is over the ${fmt(MAX_SPEND)} NEAR budget; skipping`);
if (c0 < est) throw new Error(`credit ${fmt(c0)} < estimate ${fmt(est)}; skipping (top up first)`);

// ---- generate ----
const t0 = Date.now();
const seen = { names: new Set<string>(), tickers: new Set<string>() };
const used: string[] = [];
const ideas: LaunchIdea[] = [];
for (let round = 0; round < 2 && ideas.length < N; round++) {
  const before = ideas.length;
  const res = await pool(
    (() => {
      let seq = round * 100;
      return chunkSizes(N - ideas.length).map((n) => {
        const at = seq;
        seq += n;
        return () => post("/api/generate", { prompt: process.env.PROMPT ?? "tiny desk plants with big opinions", count: n, avoid: used.slice(-24), seq: at });
      });
    })(),
    {
      concurrency: 3,
      retries: 2,
      onDone: (_i, r) => {
        if (!r.ok) return console.log(`  chunk failed: ${r.error}`);
        const fresh = dedupeIdeas((r.value as { ideas: LaunchIdea[] }).ideas, seen).slice(0, N - ideas.length);
        ideas.push(...fresh);
        for (const f of fresh) used.push(f.name, f.ticker);
        console.log(`  Generated ${ideas.length}/${N}`);
      },
    },
  );
  if (res.some((r) => !r.ok) && ideas.length === before) break;
}
console.log(`generated ${ideas.length} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// ---- launch, MAX_BATCH per vault call, sequential ----
const out: { ticker: string; ok: boolean; slug?: string | null; tokenId?: string | null; error?: string | null }[] = [];
for (const [i, part] of chunk(ideas, MAX_BATCH).entries()) {
  try {
    const r = await post("/api/launch/batch", { ideas: part, listOn: "none" });
    out.push(...r.results);
    console.log(`  chunk ${i + 1}: ${r.results.filter((x: any) => x.ok).length}/${part.length} ok · tx ${r.txHash}`);
  } catch (e) {
    const res = (e as any).body?.results;
    if (res) out.push(...res);
    else out.push(...part.map((p) => ({ ticker: p.ticker, ok: false, error: (e as Error).message })));
    console.log(`  chunk ${i + 1} failed: ${(e as Error).message}`);
  }
  console.log(`  Launched ${out.filter((x) => x.ok).length}/${ideas.length}`);
}
const c1 = await credit();
const r1 = await wallet(RELAYER);
console.log(`\nlaunched ${out.filter((x) => x.ok).length}/${ideas.length}`);
for (const r of out) console.log(`  ${r.ok ? "ok " : "ERR"} $${r.ticker.toUpperCase()} ${r.ok ? `https://yeetpad.fun/t/${r.slug ?? r.ticker}  ${r.tokenId}` : r.error}`);
console.log(`credit spent ${fmt(c0 - c1)} NEAR (now ${fmt(c1)}); relayer gas ${fmt(r0 - r1)} NEAR (relayer now ${fmt(r1)})`);

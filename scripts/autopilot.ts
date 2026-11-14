// Yeetpad Autopilot: one autonomous loop (README "Autopilot agent").
//   bun run autopilot                 # uses ./agent.config.json
// The agent signs in with its own function-call key (limited to the vault; it has no full-access key), publishes
// its human-set rules, checks the admin kill switch and its daily cap, generates ideas, drops duplicate/bad/taken
// tickers, launches them from its prepaid vault credits (optionally listing on Rhea, also credit-paid, no wallet
// prompts), and appends a run record to its public ledger (yeetpad.fun/agent/<account>).
// Exit codes: 0 ok, 2 stopped by kill switch / cap, 1 error.
import { JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LaunchIdea, MAX_BATCH, chunk, dedupeIdeas, type LaunchIdea as Idea } from "../packages/schema/src/index";

const ROOT = resolve(import.meta.dir, "..");
const cfgPath = process.env.AGENT_CONFIG ?? resolve(ROOT, "agent.config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
  name?: string;
  account: string;
  keyFile: string;
  launchesPerRun: number;
  maxCreditsPerDayNear: number;
  theme: string;
  listOn: "none" | "rhea";
  rhea?: { openingFdvNear?: number };
  schedule?: string;
};
const API = process.env.API_URL ?? "https://one-shot-launchpad-api.sushmitsarmah.workers.dev";
const VAULT = process.env.VAULT_CONTRACT ?? "launch-vault.osl-launchpad-5786.testnet";
const FACTORY = process.env.FT_FACTORY_CONTRACT ?? "ft-factory.osl-launchpad-5786.testnet";
const SITE = process.env.SITE_BASE ?? "https://yeetpad.fun";
const N = Math.max(1, Math.min(Number(process.env.N ?? cfg.launchesPerRun), 20));
if (!cfg.account.endsWith(".testnet")) throw new Error("Autopilot is testnet only");

const keyFile = cfg.keyFile.replace(/^~/, process.env.HOME ?? "");
const k = JSON.parse(readFileSync(keyFile, "utf8")) as { account_id: string; private_key: string };
if (k.account_id !== cfg.account) throw new Error(`key file is for ${k.account_id}, config says ${cfg.account}`);
const who = k.account_id;
const kp = KeyPair.fromString(k.private_key as KeyPairString);
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const fmt = (y: bigint) => (Number(y) / 1e24).toFixed(4);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const credit = async () => BigInt((await provider.callFunction({ contractId: VAULT, method: "get_balance", args: { account_id: who } })) as string);
const t0 = Date.now();
const runId = `run-${new Date(t0).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);

// ---- sign in with the limited key (NEP-413) ----
const message = `Sign in to Yeetpad\naccount: ${who}\nissued: ${new Date().toISOString()}`;
const nonce = crypto.getRandomValues(new Uint8Array(32));
const sig = await new KeyPairSigner(kp).signNep413Message(who, { message, recipient: VAULT, nonce });
const sr = await fetch(`${API}/api/auth/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ accountId: who, publicKey: kp.getPublicKey().toString(), signature: b64(sig.signature), message, nonce: b64(nonce), recipient: VAULT, callbackUrl: null }),
});
const sj = (await sr.json().catch(() => ({}))) as { token?: string; error?: string };
if (!sr.ok || !sj.token) throw new Error(`sign-in failed: ${sr.status} ${sj.error ?? ""}`);
const token = sj.token;
log(`signed in as ${who} with a function-call key (vault only)`);

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw Object.assign(new Error(`${path} ${r.status}: ${j.error ?? ""}`), { status: r.status, code: j.code, body: j });
  return j;
}

// ---- ledger ----
const ideasOut: { ticker: string; name: string }[] = [];
const dropped: { ticker: string; why: string }[] = [];
const tokens: any[] = [];
const txHashes: string[] = [];
let c0 = 0n;
async function finish(status: "ok" | "partial" | "failed" | "stopped", reason: string | null) {
  const c1 = c0 ? await credit().catch(() => c0) : 0n;
  const entry = {
    runId,
    startedAt: t0,
    finishedAt: Date.now(),
    status,
    reason,
    prompt: cfg.theme,
    listOn: cfg.listOn,
    ideas: ideasOut,
    dropped,
    tokens,
    creditsSpentYocto: (c0 > c1 ? c0 - c1 : 0n).toString(),
    txHashes: [...new Set(txHashes)].filter((h) => /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(h)),
  };
  await call("POST", "/api/agent/ledger", entry).catch((e) => log(`ledger write failed: ${(e as Error).message}`));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`run ${runId}: ${status}${reason ? ` (${reason})` : ""}; ${tokens.filter((t) => t.ok).length} launched, spent ${fmt(BigInt(entry.creditsSpentYocto))} NEAR, ${secs} s`);
  log(`ledger: ${SITE}/agent/${who}`);
  process.exit(status === "stopped" ? 2 : status === "failed" ? 1 : 0);
}

// ---- rules, kill switch, cap ----
const { account: _a, keyFile: _k, ...rules } = cfg;
await call("PUT", "/api/agent/config", rules);
const st = await call("GET", "/api/agent/status");
// SKIP_PRECHECK=1 skips the client-side kill/cap checks to show the server enforces them too.
const PRE = process.env.SKIP_PRECHECK !== "1";
if (PRE && st.paused) await finish("stopped", `kill switch on${st.kill?.reason ? `: ${st.kill.reason}` : ""}`);
c0 = await credit();
const deposit = BigInt((await provider.callFunction({ contractId: FACTORY, method: "get_required_deposit", args: {} })) as string);
const est = 10n ** 22n * BigInt(N) + deposit * BigInt(N);
const spent = BigInt(st.spentTodayYocto);
const cap = BigInt(st.capYocto);
log(`rules: ${N} launches/run, cap ${fmt(cap)} NEAR/day (spent ${fmt(spent)} today), venue ${cfg.listOn}; credits ${fmt(c0)} NEAR`);
if (PRE && spent + est > cap) await finish("stopped", `daily cap: spent ${fmt(spent)} + this run ~${fmt(est)} > ${fmt(cap)} NEAR`);
if (c0 < est) await finish("stopped", `out of credits: ${fmt(c0)} < ~${fmt(est)} NEAR`);

// ---- generate ----
const past = ((await (await fetch(`${API}/api/agent/${who}`)).json()) as any).runs ?? [];
const avoid: string[] = past.flatMap((r: any) => (r.ideas ?? []).flatMap((i: any) => [i.ticker, i.name])).slice(0, 40);
const seen = { names: new Set<string>(), tickers: new Set<string>() };
const ideas: Idea[] = [];
try {
  for (let round = 0; round < 2 && ideas.length < N; round++) {
    const want = Math.min(N - ideas.length, MAX_BATCH);
    const g = await call("POST", "/api/generate", { prompt: cfg.theme, count: want, avoid: [...avoid, ...ideas.flatMap((i) => [i.ticker, i.name])].slice(-40), seq: round * 100 });
    if (g.txHash) txHashes.push(g.txHash);
    const valid = (g.ideas as unknown[]).filter((i) => {
      const ok = LaunchIdea.safeParse(i).success;
      if (!ok) dropped.push({ ticker: String((i as any)?.ticker ?? "?").slice(0, 20), why: "failed validation" });
      return ok;
    }) as Idea[];
    const fresh = dedupeIdeas(valid, seen);
    const freshNames = new Set(fresh.map((f) => f.name));
    for (const v of valid) if (!freshNames.has(v.name)) dropped.push({ ticker: v.ticker, why: "duplicate" });
    const take = fresh.slice(0, N - ideas.length);
    ideas.push(...take);
    for (const i of take) ideasOut.push({ ticker: i.ticker, name: i.name });
    log(`generated ${ideas.length}/${N} (${g.ideas.length} from the model, ${g.charged === "0" ? "own key" : `${fmt(BigInt(g.charged))} NEAR`})`);
  }
} catch (e) {
  const err = e as any;
  await finish(err.code === "agent_paused" || err.code === "agent_cap" ? "stopped" : "failed", `generate: ${err.message}`);
}
if (!ideas.length) await finish("failed", "no usable ideas");

// ---- launch (credit-paid; Rhea listing too, no wallet prompts) ----
for (const part of chunk(ideas, MAX_BATCH)) {
  let batch = part;
  for (let attempt = 0; attempt < 2 && batch.length; attempt++) {
    try {
      const r = await call("POST", "/api/launch/batch", { ideas: batch, listOn: cfg.listOn, ...(cfg.listOn === "rhea" && cfg.rhea ? { rhea: cfg.rhea } : {}) });
      txHashes.push(r.txHash);
      for (const x of r.results) {
        const idea = batch.find((i) => i.ticker === x.ticker);
        if (x.listing?.txHash) txHashes.push(x.listing.txHash);
        tokens.push({ ticker: x.ticker, name: idea?.name, ok: x.ok, tokenId: x.tokenId, slug: x.slug, error: x.error ?? null, listing: x.listing ? { ok: x.listing.ok, url: x.listing.url, txHash: x.listing.txHash } : null });
        log(`  ${x.ok ? "launched" : "FAILED  "} $${x.ticker.toUpperCase()} ${x.ok ? `${SITE}/t/${x.slug ?? x.ticker}` : x.error}${x.listing ? ` · Rhea ${x.listing.ok ? "listed" : `failed: ${x.listing.error}`}` : ""}`);
      }
      batch = [];
    } catch (e) {
      const err = e as any;
      if (err.status === 409 && Array.isArray(err.body?.taken)) {
        for (const t of err.body.taken) dropped.push({ ticker: t, why: "ticker already taken" });
        batch = batch.filter((i) => !err.body.taken.includes(i.ticker));
        log(`  dropped taken ticker(s): ${err.body.taken.join(", ")}`);
        continue;
      }
      if (err.code === "agent_paused" || err.code === "agent_cap") await finish(tokens.some((t) => t.ok) ? "partial" : "stopped", `launch: ${err.message}`);
      for (const i of batch) tokens.push({ ticker: i.ticker, name: i.name, ok: false, tokenId: null, slug: null, error: err.message.slice(0, 200) });
      log(`  launch failed: ${err.message}`);
      batch = [];
    }
  }
}
const ok = tokens.filter((t) => t.ok).length;
await finish(ok === ideas.length ? "ok" : ok ? "partial" : "failed", null);

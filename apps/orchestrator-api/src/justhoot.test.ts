import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { JusthootPrepareResponse, JusthootFinalizeResponse, QuoteResponse } from "@osl/schema";
import { signIn } from "./test-helpers";
import {
  buildLaunchArgs,
  fitIcon,
  ICON_MAX_CHARS,
  justhootProblem,
  justhootStatus,
  justhootTokenId,
  parseLaunchLogs,
  quoteJusthoot,
  referenceJson,
  setJusthootTxLookup,
  setJusthootView,
  sha256Base64,
} from "./justhoot";

const FACTORY = "v2-launchpad.justhoot.near";
let app: typeof import("./app").app;
let config: typeof import("./config").config;
const RECIPIENT = "launch-vault.mock.testnet";
const calls: { method: string; args: any }[] = [];
let isPublic = true;
// Mock RPC: deposit = 0.0383 NEAR + 1e19 per icon char (matches mainnet's observed slope), gas 446/461 Tgas.
const mockView = async (contractId: string, method: string, args: any) => {
  calls.push({ method, args });
  if (method === "ft_metadata") {
    if (contractId === `taken.${FACTORY}`) return { symbol: "TAKEN" };
    throw new Error(`account ${contractId} does not exist while viewing`);
  }
  if (contractId !== FACTORY) throw new Error("wrong contract");
  if (method === "is_public_launch") return isPublic;
  if (method === "is_whitelisted_creator") return args.account_id === "vip.near";
  if (method === "get_launch_deposit") return (38_250_000_000_000_000_000_000n + BigInt(args.args.icon?.length ?? 0) * 10n ** 19n).toString();
  if (method === "get_launch_gas") return args.args.icon ? 461 : 446;
  throw new Error(`unexpected ${method}`);
};

beforeAll(async () => {
  process.env.LLM_MOCK = "1";
  process.env.NEAR_MOCK = "1";
  process.env.SESSION_SECRET = "test-secret";
  process.env.VAULT_CONTRACT = RECIPIENT;
  process.env.LOCKED = "0";
  ({ app } = await import("./app"));
  ({ config } = await import("./config"));
  (await import("./config")).configureFromEnv({});
  config.justhootEnabled = true;
  config.justhootFactory = FACTORY;
  setJusthootView(mockView);
});
afterAll(() => {
  config.justhootEnabled = false;
  setJusthootView(null);
  setJusthootTxLookup(null);
});

async function token(account: string) {
  const req = await signIn(KeyPair.fromRandom("ed25519"), account, RECIPIENT);
  const r = await app.request("/api/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  return (await r.json()).token as string;
}
const post = (path: string, body: unknown, t: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify(body) });
const idea = async (t: string, ticker: string) => ({ ...(await (await post("/api/generate", { prompt: "hoot test" }, t)).json()).idea, ticker });

describe("justhoot args + icon", () => {
  const i = { name: "A very long token name that is way over thirty-two chars", ticker: "hoot1" };
  test("launch_meme args match JustHoot's own defaults (no first buy, no transfer fee, all shares to creator)", () => {
    const a = buildLaunchArgs(i, "data:image/webp;base64,AAAA", { url: "https://api.example/ref.json", hash: "h" });
    expect(a).toEqual({
      name: i.name.slice(0, 32),
      symbol: "HOOT1",
      icon: "data:image/webp;base64,AAAA",
      reference: "https://api.example/ref.json",
      reference_hash: "h",
      quote_token_id: "wrap.near",
      dev_buy_quote_max: null,
      transfer_fee_pips: 0,
      shares: { token_owner_bps: 10000, burn_bps: 0, holders_bps: 0 },
    });
    const b = buildLaunchArgs(i, null, null);
    expect(b.icon).toBeNull();
    expect(b.reference).toBeNull();
    expect(b.reference_hash).toBeNull();
  });
  test("icon: first data:image/ candidate within 7000 chars, else none", () => {
    const at = "data:image/webp;base64," + "A".repeat(ICON_MAX_CHARS - 23);
    const over = at + "A";
    const svg = "data:image/svg+xml,%3Csvg%3E%3C/svg%3E";
    expect(at.length).toBe(7000);
    expect(fitIcon([at, svg])).toBe(at);
    expect(fitIcon([over, svg])).toBe(svg);
    expect(fitIcon([undefined, "https://x/y.png", svg])).toBe(svg);
    expect(fitIcon([over, over])).toBeNull();
  });
  test("ticker/name limits and token id", () => {
    expect(justhootProblem({ name: "Ok", ticker: "abcdefghij" })).toBeNull();
    expect(justhootProblem({ name: "Ok", ticker: "abcdefghijk" })).toContain("max 10");
    expect(justhootTokenId("HOOT1", FACTORY)).toBe(`hoot1.${FACTORY}`);
  });
  test("reference JSON hash is base64 sha256 of the exact bytes", async () => {
    const j = referenceJson({ tagline: "t", description: "d" }, "https://yeetpad.fun/t/x");
    expect(JSON.parse(j)).toEqual({ description: "t", about: "d", website: "https://yeetpad.fun/t/x" });
    expect(await sha256Base64("abc")).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });
});

describe("justhoot quoting + gating (mock RPC)", () => {
  test("deposit comes from get_launch_deposit (with/without icon), gas from get_launch_gas", async () => {
    const no = await quoteJusthoot(buildLaunchArgs({ name: "N", ticker: "nn" }, null, null), "me.near");
    expect(no).toEqual({ deposit: "38250000000000000000000", gas: (446n * 10n ** 12n).toString() });
    const withIcon = await quoteJusthoot(buildLaunchArgs({ name: "N", ticker: "nn" }, "data:image/webp;base64," + "A".repeat(977), null), "me.near");
    expect(withIcon.deposit).toBe((38_250_000_000_000_000_000_000n + 1000n * 10n ** 19n).toString());
    expect(withIcon.gas).toBe((461n * 10n ** 12n).toString());
    expect(calls.find((c) => c.method === "get_launch_deposit")?.args.account_id).toBe("me.near");
  });
  test("flag off: disabled with the mainnet reason and no RPC call", async () => {
    config.justhootEnabled = false;
    const n = calls.length;
    const s = await justhootStatus("me.near");
    config.justhootEnabled = true;
    expect(s).toEqual({ enabled: false, reason: "mainnet only, enabled at mainnet launch", isPublic: null });
    expect(calls.length).toBe(n);
  });
  test("is_public_launch false: disabled unless the creator is whitelisted", async () => {
    isPublic = false;
    const s = await justhootStatus("me.near");
    const vip = await justhootStatus("vip.near");
    isPublic = true;
    expect(s.enabled).toBe(false);
    expect(s.reason).toContain("whitelist-only");
    expect(vip.enabled).toBe(true);
    expect((await justhootStatus("me.near")).enabled).toBe(true);
  });
  test("launch events: meme_launched, launch_rejected", () => {
    const log = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "hoot_launcher_v2", version: "1.0.0", event, data })}`;
    const r = parseLaunchLogs(
      [
        { outcome: { executor_id: FACTORY, logs: [log("meme_launched", { token_id: `a.${FACTORY}`, creator_id: "me.near" })] } },
        { outcome: { executor_id: "other.near", logs: [log("meme_launched", { token_id: "x", creator_id: "me.near" })] } },
        { outcome: { executor_id: FACTORY, logs: [log("launch_rejected", { reason: "stale price" })] } },
      ],
      FACTORY,
    );
    expect(r.launched).toEqual([{ token_id: `a.${FACTORY}`, creator_id: "me.near" }]);
    expect(r.failures[0]).toContain("stale price");
  });
});

describe("justhoot routes (mock)", () => {
  test("health exposes the flag; flag off -> prepare/quote 503", async () => {
    const t = await token("hoot0.testnet");
    config.justhootEnabled = false;
    const h = await (await app.request("/api/health")).json();
    const p = await post("/api/justhoot/prepare", { ideas: [await idea(t, "jhoff")] }, t);
    const q = await post("/api/quote", { ideas: [await idea(t, "jhoff")], listOn: "justhoot" }, t);
    config.justhootEnabled = true;
    expect(h.venues.justhoot).toMatchObject({ enabled: false, reason: "mainnet only, enabled at mainnet launch", factory: FACTORY });
    expect(p.status).toBe(503);
    expect(q.status).toBe(503);
  });

  test("quote uses the deposit view; prepare builds launch_meme with icon + our reference; finalize records it", async () => {
    const owner = "hooter.testnet";
    const t = await token(owner);
    const ideas = [await idea(t, "jhone"), await idea(t, "jhtwo")];
    const webp = "data:image/webp;base64," + "B".repeat(3000);
    const q = QuoteResponse.parse(await (await post("/api/quote", { ideas, listOn: "justhoot", icons: { jhone: webp } }, t)).json());
    expect(q.items[0].paidFrom).toBe("wallet");
    expect(BigInt(q.items[0].total)).toBe(38_250_000_000_000_000_000_000n + BigInt(webp.length) * 10n ** 19n);
    expect(q.notes.join(" ")).toContain("Yeetpad site page");

    const res = await post("/api/justhoot/prepare", { ideas, icons: { jhone: webp, jhtwo: "data:image/webp;base64," + "C".repeat(8000) } }, t);
    const body = await res.json();
    if (res.status !== 200) console.log(body);
    const r = JusthootPrepareResponse.parse(body);
    expect(r.txs.map((x) => x.methodName)).toEqual(["launch_meme", "launch_meme"]);
    expect(r.txs[0].receiverId).toBe(FACTORY);
    expect(r.txs[0].gas).toBe((461n * 10n ** 12n).toString());
    const a0 = (r.txs[0].args as any).args;
    const a1 = (r.txs[1].args as any).args;
    expect(a0.icon).toBe(webp);
    expect(a1.icon.startsWith("data:image/svg+xml")).toBe(true); // oversized webp -> our SVG
    expect(r.txs[0].deposit).toBe((38_250_000_000_000_000_000_000n + BigInt(webp.length) * 10n ** 19n).toString());
    expect(BigInt(r.total)).toBe(BigInt(r.txs[0].deposit) + BigInt(r.txs[1].deposit));
    expect(a0.reference).toBe(`${config.publicApiBase}/api/justhoot/ref/jhone.json`);
    const ref = await app.request("/api/justhoot/ref/jhone.json");
    const refText = await ref.text();
    expect(await sha256Base64(refText)).toBe(a0.reference_hash);
    expect(JSON.parse(refText).website).toBe(`https://yeetpad.fun/t/${r.txs[0].slug}`);

    const log = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "hoot_launcher_v2", version: "1.0.0", event, data })}`;
    setJusthootTxLookup(async (hash) => ({
      signer: owner,
      receipts: [
        {
          outcome: {
            executor_id: FACTORY,
            logs: hash.startsWith("ok") ? [log("meme_launched", { token_id: `jhone.${FACTORY}`, creator_id: owner })] : [log("launch_rejected", { reason: "no price" })],
          },
        },
      ],
    }));
    const f = JusthootFinalizeResponse.parse(
      await (
        await post("/api/justhoot/finalize", { items: [{ ticker: "jhone", txHash: "ok".padEnd(44, "1") }, { ticker: "jhtwo", txHash: "bad".padEnd(44, "1") }] }, t)
      ).json(),
    );
    expect(f.results[0]).toMatchObject({ ok: true, tokenId: `jhone.${FACTORY}` });
    expect(f.results[0].listing?.url).toBe(`https://justhoot.fun/p/jhone.${FACTORY}`);
    expect(f.results[1].ok).toBe(false);
    expect(f.results[1].error).toContain("no price");
    const l = await (await app.request(`/api/launches/${owner}`)).json();
    const mine = l.launches.find((x: any) => x.ticker === "jhone");
    expect(mine.venue).toBe("justhoot");
    expect(mine.venueUrl).toBe(`https://justhoot.fun/p/jhone.${FACTORY}`);
  });

  test("prepare rejects a ticker already taken on JustHoot and tickers over 10 chars", async () => {
    const t = await token("hoot2.testnet");
    expect((await post("/api/justhoot/prepare", { ideas: [await idea(t, "taken")] }, t)).status).toBe(409);
    expect((await post("/api/justhoot/prepare", { ideas: [await idea(t, "abcdefghijk")] }, t)).status).toBe(400);
  });
});

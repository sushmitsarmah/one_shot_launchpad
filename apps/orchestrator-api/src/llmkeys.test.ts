import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { signIn } from "./test-helpers";
import {
  aadFor,
  cleanKey,
  decryptSecret,
  encryptSecret,
  guardedFetch,
  importMasterKey,
  isAllowedUrl,
  KEY_RATE_LIMIT,
  PLATFORM,
  recordKey,
} from "./llmkeys";
import { kvStore } from "./sites";

const RECIPIENT = "launch-vault.byok.testnet";
const ADMIN = "boss-byok.testnet";
const MASTER = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const GOOD = "ollama-good-key-0123456789abcdWXYZ";
const GOOD2 = "nearai-good-key-0123456789abcdQRST";
const PLATFORM_ENV = "platform-env-key-0123456789-ENV1";
const IDEA = { name: "Byok Coin", ticker: "byok", tagline: "Your key, your coin.", description: "A token generated with the user's own key.", colors: { primary: "#112233", secondary: "#445566", accent: "#778899", background: "#000000", text: "#ffffff" } };

let app: typeof import("./app").app;
let configureFromEnv: typeof import("./config").configureFromEnv;
const realFetch = globalThis.fetch;
const calls: { url: string; auth: string | null; body?: string }[] = [];
let chatStatus = 200;
/** Formats this "model" rejects with 400 (to exercise the json_schema → json_object → plain fallback). */
let rejectFormats: string[] = [];
const logs: string[] = [];
const realLog = console.log;
const realErr = console.error;

function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = req.url;
  const auth = req.headers.get("authorization") ?? (init?.headers ? new Headers(init.headers).get("authorization") : null);
  const bearer = auth?.replace(/^Bearer\s+/i, "") ?? "";
  return (async () => {
    const body = init?.body ? String(init.body) : await req.clone().text().catch(() => "");
    calls.push({ url, auth, body });
    const ok = [GOOD, GOOD2, PLATFORM_ENV].includes(bearer);
    const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
    if (url === "https://ollama.com/api/me") return ok ? json({ ID: "x" }) : json({ error: "unauthorized" }, 401);
    if (url.endsWith("/models")) return json({ object: "list", data: [{ id: "big-model" }, { id: "gemma4:31b" }, { id: "z-ai/glm-5.3-flash", pricing: { completion: "0.0000002" } }] });
    if (url.endsWith("/chat/completions")) {
      if (!ok) return json({ error: { message: `Incorrect API key provided: ${bearer}` } }, 401);
      const fmt = (JSON.parse(body || "{}").response_format?.type as string | undefined) ?? "plain";
      if (rejectFormats.includes(fmt)) return json({ error: { message: `response_format ${fmt} unsupported` } }, 400);
      if (chatStatus !== 200) return json({ error: { message: `quota for ${bearer}` } }, chatStatus);
      return json({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(IDEA) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    }
    return json({ error: "unexpected" }, 500);
  })();
}

beforeAll(async () => {
  ({ app } = await import("./app"));
  ({ configureFromEnv } = await import("./config"));
  configureFromEnv({
    LLM_MOCK: "0",
    NEAR_MOCK: "1",
    SESSION_SECRET: "byok-secret",
    VAULT_CONTRACT: RECIPIENT,
    LOCKED: "0",
    ADMIN_ACCOUNTS: ADMIN,
    KEY_ENCRYPTION_KEY: MASTER,
    NEARAI_BASE_URL: "https://ollama.com/v1",
    NEARAI_MODEL: "gemma4:31b",
    NEARAI_API_KEY: PLATFORM_ENV,
  });
  globalThis.fetch = stubFetch as typeof fetch;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(" "));
});
afterAll(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realErr;
  configureFromEnv({ LLM_MOCK: "1", NEAR_MOCK: "1", LOCKED: "0" });
});
beforeEach(() => {
  chatStatus = 200;
  rejectFormats = [];
});

const tokens = new Map<string, string>();
async function session(account: string) {
  if (!tokens.has(account)) {
    const req = await signIn(KeyPair.fromRandom("ed25519"), account, RECIPIENT);
    const r = await app.request("/api/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    expect(r.status).toBe(200);
    tokens.set(account, (await r.json()).token);
  }
  return tokens.get(account)!;
}
async function call(method: string, path: string, account: string | null, body?: unknown) {
  const r = await app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(account ? { authorization: `Bearer ${await session(account)}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text || "{}") };
}
const balance = async (a: string) => BigInt((await (await app.request(`/api/balance/${a}`)).json()).balance);
const noKeysIn = (s: string) => {
  for (const k of [GOOD, GOOD2, PLATFORM_ENV]) expect(s.includes(k)).toBe(false);
};

describe("crypto", () => {
  test("AES-256-GCM round trip; fresh IV per record", async () => {
    const m = await importMasterKey(MASTER);
    const a = await encryptSecret(m, GOOD, aadFor("alice.testnet", "ollama"));
    const b = await encryptSecret(m, GOOD, aadFor("alice.testnet", "ollama"));
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(Buffer.from(a.iv, "base64").length).toBe(12);
    expect(a.ct.includes(GOOD)).toBe(false);
    expect(await decryptSecret(m, a, aadFor("alice.testnet", "ollama"))).toBe(GOOD);
  });
  test("wrong AAD (other account or provider), tampering or other master key fail", async () => {
    const m = await importMasterKey(MASTER);
    const box = await encryptSecret(m, GOOD, aadFor("alice.testnet", "ollama"));
    await expect(decryptSecret(m, box, aadFor("bob.testnet", "ollama"))).rejects.toThrow();
    await expect(decryptSecret(m, box, aadFor("alice.testnet", "nearai"))).rejects.toThrow();
    const ct = Buffer.from(box.ct, "base64");
    ct[0] ^= 1;
    await expect(decryptSecret(m, { iv: box.iv, ct: ct.toString("base64") }, aadFor("alice.testnet", "ollama"))).rejects.toThrow();
    const other = await importMasterKey(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"));
    await expect(decryptSecret(other, box, aadFor("alice.testnet", "ollama"))).rejects.toThrow();
  });
  test("master key must be 32 bytes", () => {
    expect(() => importMasterKey(Buffer.from("short").toString("base64"))).toThrow();
  });
  test("cleanKey strips whitespace and enforces length", () => {
    expect(cleanKey(`  ${GOOD.slice(0, 10)}\n ${GOOD.slice(10)}\t`)).toBe(GOOD);
    expect(() => cleanKey("x".repeat(513))).toThrow(/too long/);
    expect(() => cleanKey("abc")).toThrow(/too short/);
    expect(() => cleanKey("abcdefgh\u00e9ij")).toThrow();
  });
});

describe("allowlist", () => {
  test("only the two provider base URLs (https) pass", () => {
    expect(isAllowedUrl("https://ollama.com/v1/chat/completions")).toBe(true);
    expect(isAllowedUrl("https://cloud-api.near.ai/v1/models")).toBe(true);
    expect(isAllowedUrl("https://ollama.com/api/me")).toBe(true);
    for (const bad of [
      "http://ollama.com/v1/models",
      "https://api.openai.com/v1/models",
      "https://openrouter.ai/api/v1/models",
      "https://ollama.com.evil.com/v1/models",
      "https://ollama.com@evil.com/v1/models",
      "https://user:pw@ollama.com/v1/models",
      "https://ollama.com:8443/v1/models",
      "https://ollama.com/v2/models",
      "https://ollama.com/v1",
      "https://ollama.com/api/tags",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/v1/models",
      "not a url",
    ]) expect(isAllowedUrl(bad)).toBe(false);
  });
  test("guardedFetch refuses other URLs without sending anything", async () => {
    const n = calls.length;
    await expect(guardedFetch("https://evil.example/v1/models", { headers: { authorization: `Bearer ${GOOD}` } })).rejects.toThrow(/allowlist/);
    expect(calls.length).toBe(n);
  });
  test("API rejects unknown providers and custom base URLs", async () => {
    const a = await call("PUT", "/api/llm/key", "alice.testnet", { provider: "openai", apiKey: GOOD });
    expect(a.status).toBe(400);
    const b = await call("PUT", "/api/llm/key", "alice.testnet", { provider: "ollama", apiKey: GOOD, baseUrl: "https://evil.example/v1" });
    expect(b.status).toBe(400);
    expect(b.json.code).toBe("url_not_allowed");
    noKeysIn(a.text + b.text);
  });
});

describe("user key API", () => {
  test("requires a session", async () => {
    expect((await call("GET", "/api/llm/key", null)).status).toBe(401);
    expect((await call("PUT", "/api/llm/key", null, { provider: "ollama", apiKey: GOOD })).status).toBe(401);
    expect((await call("DELETE", "/api/llm/key", null)).status).toBe(401);
  });

  test("models are fetched server-side with the key; cheap default first", async () => {
    const r = await call("POST", "/api/llm/models", "carol.testnet", { provider: "ollama", apiKey: GOOD });
    expect(r.status).toBe(200);
    expect(r.json.defaultModel).toBe("gemma4:31b");
    expect(calls.at(-1)!.auth).toBe(`Bearer ${GOOD}`);
    noKeysIn(r.text);
  });

  test("invalid key is rejected and not stored", async () => {
    const r = await call("PUT", "/api/llm/key", "dave.testnet", { provider: "ollama", apiKey: "definitely-wrong-key-123" });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("key_invalid");
    expect(r.text.includes("definitely-wrong-key-123")).toBe(false);
    expect(await kvStore().get(recordKey("dave.testnet"))).toBeNull();
  });

  test("save → write-only summary; KV holds only ciphertext", async () => {
    const r = await call("PUT", "/api/llm/key", "alice.testnet", { provider: "ollama", apiKey: ` ${GOOD}\n` });
    expect(r.status).toBe(200);
    expect(r.json.key).toMatchObject({ provider: "ollama", model: "gemma4:31b", last4: "WXYZ", valid: true });
    expect(Object.keys(r.json.key).sort()).toEqual(["createdAt", "last4", "lastError", "model", "provider", "providerLabel", "updatedAt", "valid", "validatedAt"]);
    noKeysIn(r.text);
    const g = await call("GET", "/api/llm/key", "alice.testnet");
    expect(g.json.key.last4).toBe("WXYZ");
    noKeysIn(g.text);
    const raw = (await kvStore().get(recordKey("alice.testnet")))!;
    noKeysIn(raw);
    expect(raw.includes("WXYZ")).toBe(false);
    const rec = JSON.parse(raw);
    expect(rec).toMatchObject({ v: 1, kv: 1, provider: "ollama" });
    expect(typeof rec.ct).toBe("string");
    // Another account can't read it: their GET shows nothing.
    expect((await call("GET", "/api/llm/key", "bob.testnet")).json.key).toBeNull();
  });

  test("replace model only (no key resent) and replace key", async () => {
    const m = await call("PUT", "/api/llm/key", "alice.testnet", { provider: "ollama", model: "big-model" });
    expect(m.status).toBe(200);
    expect(m.json.key).toMatchObject({ model: "big-model", last4: "WXYZ" });
    const bad = await call("PUT", "/api/llm/key", "alice.testnet", { provider: "ollama", model: "nope-model" });
    expect(bad.status).toBe(400);
    const back = await call("PUT", "/api/llm/key", "alice.testnet", { provider: "ollama", apiKey: GOOD, model: "gemma4:31b" });
    expect(back.json.key.model).toBe("gemma4:31b");
    noKeysIn(m.text + bad.text + back.text);
  });

  test("generation with the user's key skips the AI charge and uses their key", async () => {
    const before = await balance("alice.testnet");
    const n = calls.length;
    const r = await call("POST", "/api/generate", "alice.testnet", { prompt: "a coin for my own key" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ charged: "0", txHash: null, keySource: "user", provider: "ollama", model: "gemma4:31b" });
    expect(await balance("alice.testnet")).toBe(before);
    const chat = calls.slice(n).filter((c) => c.url.endsWith("/chat/completions"));
    expect(chat.length).toBe(1);
    expect(chat[0].url).toBe("https://ollama.com/v1/chat/completions");
    expect(chat[0].auth).toBe(`Bearer ${GOOD}`);
    noKeysIn(r.text);
  });

  test("format fallback works with the user's key (json_schema → json_object → plain)", async () => {
    for (const rej of [["json_schema"], ["json_schema", "json_object"]]) {
      rejectFormats = rej;
      const n = calls.length;
      const r = await call("POST", "/api/generate", "alice.testnet", { prompt: "fallback formats" });
      expect(r.status).toBe(200);
      expect(r.json.charged).toBe("0");
      expect(calls.slice(n).filter((c) => c.url.endsWith("/chat/completions")).length).toBe(rej.length + 1);
    }
  });

  test("quota error: clear 424, nothing charged, no silent fallback; then explicit platform fallback charges", async () => {
    const before = await balance("alice.testnet");
    chatStatus = 429;
    const r = await call("POST", "/api/generate", "alice.testnet", { prompt: "a coin for my own key" });
    expect(r.status).toBe(424);
    expect(r.json.code).toBe("user_key_failed");
    expect(r.json.error).toMatch(/429/);
    expect(r.json.fallbackCost).toBe("10000000000000000000000");
    noKeysIn(r.text);
    expect(await balance("alice.testnet")).toBe(before);
    chatStatus = 200;
    const n = calls.length;
    const f = await call("POST", "/api/generate", "alice.testnet", { prompt: "a coin for my own key", usePlatformKey: true });
    expect(f.status).toBe(200);
    expect(f.json.charged).toBe("10000000000000000000000");
    expect(f.json.keySource).toBe("env");
    expect(calls.slice(n).find((c) => c.url.endsWith("/chat/completions"))!.auth).toBe(`Bearer ${PLATFORM_ENV}`);
    expect(await balance("alice.testnet")).toBe(before - 10n ** 22n);
  });

  test("a revoked key (401) is marked invalid and explained", async () => {
    await call("PUT", "/api/llm/key", "erin.testnet", { provider: "ollama", apiKey: GOOD });
    // Simulate the provider revoking it: chat rejects the key now.
    const rec = JSON.parse((await kvStore().get(recordKey("erin.testnet")))!);
    chatStatus = 401;
    const r = await call("POST", "/api/generate", "erin.testnet", { prompt: "revoked key test" });
    expect(r.status).toBe(424);
    expect(r.json.error).toMatch(/rejected the key/);
    noKeysIn(r.text);
    const after = JSON.parse((await kvStore().get(recordKey("erin.testnet")))!);
    expect(after.valid).toBe(false);
    expect(after.ct).toBe(rec.ct);
    const again = await call("POST", "/api/generate", "erin.testnet", { prompt: "revoked key test" });
    expect(again.json.code).toBe("user_key_invalid");
  });

  test("test + delete", async () => {
    const t = await call("POST", "/api/llm/key/test", "erin.testnet");
    expect(t.json.ok).toBe(true);
    expect(t.json.key.valid).toBe(true);
    const d = await call("DELETE", "/api/llm/key", "erin.testnet");
    expect(d.status).toBe(200);
    expect(await kvStore().get(recordKey("erin.testnet"))).toBeNull();
    expect((await call("GET", "/api/llm/key", "erin.testnet")).json.key).toBeNull();
  });

  test("save/test is rate-limited per account", async () => {
    let last = 0;
    for (let i = 0; i <= KEY_RATE_LIMIT; i++) last = (await call("PUT", "/api/llm/key", "frank.testnet", { provider: "ollama", apiKey: GOOD })).status;
    expect(last).toBe(429);
    // Other accounts are unaffected.
    expect((await call("PUT", "/api/llm/key", "gina.testnet", { provider: "ollama", apiKey: GOOD })).status).toBe(200);
  });
});

describe("platform key (admin)", () => {
  test("non-admins can't read, set, test or delete it", async () => {
    for (const [m, p] of [["GET", "/api/admin/llm-key"], ["PUT", "/api/admin/llm-key"], ["POST", "/api/admin/llm-key/test"], ["DELETE", "/api/admin/llm-key"], ["POST", "/api/admin/llm-models"]] as const) {
      const r = await call(m, p, "alice.testnet", m === "PUT" ? { provider: "nearai", apiKey: GOOD2 } : m === "POST" ? { provider: "nearai", apiKey: GOOD2 } : undefined);
      expect(r.status).toBe(403);
    }
    expect(await kvStore().get(recordKey(PLATFORM))).toBeNull();
  });

  test("admin sets it; it takes precedence over the env key; never returned", async () => {
    const info = await call("GET", "/api/admin/llm-key", ADMIN);
    expect(info.json.active).toBe("env");
    expect(info.json.env.last4).toBe("ENV1");
    noKeysIn(info.text);
    const s = await call("PUT", "/api/admin/llm-key", ADMIN, { provider: "nearai", apiKey: GOOD2 });
    expect(s.status).toBe(200);
    expect(s.json.stored).toMatchObject({ provider: "nearai", model: "z-ai/glm-5.3-flash", last4: "QRST", valid: true });
    expect(s.json.active).toBe("platform");
    noKeysIn(s.text);
    noKeysIn((await kvStore().get(recordKey(PLATFORM)))!);
    const n = calls.length;
    const g = await call("POST", "/api/generate", "hank.testnet", { prompt: "platform key wins" });
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ keySource: "platform", provider: "nearai", charged: "10000000000000000000000" });
    const chat = calls.slice(n).find((c) => c.url.endsWith("/chat/completions"))!;
    expect(chat.url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect(chat.auth).toBe(`Bearer ${GOOD2}`);
    const t = await call("POST", "/api/admin/llm-key/test", ADMIN);
    expect(t.json).toMatchObject({ ok: true, tested: "platform" });
    noKeysIn(t.text);
    const d = await call("DELETE", "/api/admin/llm-key", ADMIN);
    expect(d.json.active).toBe("env");
  });
});

test("no key ever reached a log line", () => {
  expect(logs.some((l) => l.includes("llm_usage"))).toBe(true);
  noKeysIn(logs.join("\n"));
});

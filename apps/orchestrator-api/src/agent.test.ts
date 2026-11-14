import { describe, expect, test } from "bun:test";
import { KeyPair } from "near-api-js";
import { AuthError, agentKeyAllowed, verifySignIn, type KeyPermission } from "./auth";
import { addSpend, appendLedger, assertAgentBudget, assertAgentRunning, isAgentAccount, readLedger, setAgent, setKill, putRules, nearToYocto, LedgerEntry } from "./agent";
import { MemoryKV } from "./sites";
import { signIn } from "./test-helpers";

const VAULT = "launch-vault.test.testnet";
const AGENT = "autopilot.test.testnet";
const fc = (receiver: string): KeyPermission => ({ FunctionCall: { receiver_id: receiver, method_names: [], allowance: null } });
const cfg = { agentAccounts: [AGENT], agentMaxDailyNear: 2 };

const rejects = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(() => null, (err) => err);
  expect(e).toBeInstanceOf(AuthError);
  expect((e as Error).message).toMatch(re);
};

describe("agent sign-in key rule", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();
  // Chain stub: every account has `pk` as a FunctionCall key whose receiver is given per account.
  const receivers: Record<string, string> = { [AGENT]: VAULT, "bob.testnet": VAULT, "other-agent.testnet": "evil.testnet" };
  const agents = new Set([AGENT, "other-agent.testnet"]);
  const opts = {
    recipient: VAULT,
    isFullAccessKey: async () => false,
    isAgentKey: async (acc: string, key: string) => key === pk && agentKeyAllowed(fc(receivers[acc] ?? "x"), { vaultContract: VAULT, isAgent: agents.has(acc) }),
  };

  test("vault-limited function-call key on an allowed agent passes", async () => {
    expect(await verifySignIn(await signIn(kp, AGENT, VAULT), opts)).toBe(AGENT);
  });
  test("the same kind of key on a non-agent account fails", async () => {
    await rejects(verifySignIn(await signIn(kp, "bob.testnet", VAULT), opts), /full-access key/);
  });
  test("a function-call key with a different receiver fails, even on an agent", async () => {
    await rejects(verifySignIn(await signIn(kp, "other-agent.testnet", VAULT), opts), /full-access key/);
  });
  test("without isAgentKey (normal users) a function-call key still fails", async () => {
    await rejects(verifySignIn(await signIn(kp, AGENT, VAULT), { recipient: VAULT, isFullAccessKey: async () => false }), /full-access key/);
  });
  test("agentKeyAllowed: full access / missing key / non-agent are all false", () => {
    expect(agentKeyAllowed("FullAccess", { vaultContract: VAULT, isAgent: true })).toBe(false);
    expect(agentKeyAllowed(null, { vaultContract: VAULT, isAgent: true })).toBe(false);
    expect(agentKeyAllowed(fc(VAULT), { vaultContract: VAULT, isAgent: false })).toBe(false);
    expect(agentKeyAllowed(fc(VAULT), { vaultContract: VAULT, isAgent: true })).toBe(true);
  });
});

describe("agent registry, kill switch and daily cap", () => {
  test("env and KV registry", async () => {
    const kv = new MemoryKV();
    expect(await isAgentAccount(AGENT, cfg, kv)).toBe(true);
    expect(await isAgentAccount("x.testnet", cfg, kv)).toBe(false);
    await setAgent(kv, "x.testnet", true, "admin.testnet");
    expect(await isAgentAccount("x.testnet", cfg, kv)).toBe(true);
    await setAgent(kv, "x.testnet", false, "admin.testnet");
    expect(await isAgentAccount("x.testnet", cfg, kv)).toBe(false);
  });
  test("kill switch blocks the agent, not other users", async () => {
    const kv = new MemoryKV();
    await assertAgentRunning(AGENT, cfg, kv);
    await setKill(kv, AGENT, true, "admin.testnet", "demo");
    await rejects(assertAgentRunning(AGENT, cfg, kv), /kill switch: demo/);
    await assertAgentRunning("bob.testnet", cfg, kv); // normal user unaffected
    await setKill(kv, AGENT, false, "admin.testnet");
    await assertAgentRunning(AGENT, cfg, kv);
  });
  test("daily cap = min(own rules, server ceiling)", async () => {
    const kv = new MemoryKV();
    await putRules(kv, AGENT, { launchesPerRun: 3, maxCreditsPerDayNear: 0.5, theme: "cats", listOn: "none" });
    await assertAgentBudget(AGENT, nearToYocto(0.4), cfg, kv);
    await addSpend(kv, AGENT, nearToYocto(0.4));
    await rejects(assertAgentBudget(AGENT, nearToYocto(0.2), cfg, kv), /daily cap reached/);
    await putRules(kv, AGENT, { launchesPerRun: 3, maxCreditsPerDayNear: 50, theme: "cats", listOn: "none" });
    await assertAgentBudget(AGENT, nearToYocto(1.5), cfg, kv);
    await rejects(assertAgentBudget(AGENT, nearToYocto(1.7), cfg, kv), /of 2\.0000 NEAR/); // server ceiling
    await assertAgentBudget("bob.testnet", nearToYocto(99), cfg, kv); // not an agent
  });
  test("ledger appends newest first and validates entries", async () => {
    const kv = new MemoryKV();
    const e = { runId: "run-1", startedAt: 1, finishedAt: 2, status: "ok" as const, prompt: "p", listOn: "none" as const, ideas: [], tokens: [], creditsSpentYocto: "0", txHashes: [] };
    await appendLedger(kv, AGENT, e);
    await appendLedger(kv, AGENT, { ...e, runId: "run-2" });
    expect((await readLedger(kv, AGENT)).map((x) => x.runId)).toEqual(["run-2", "run-1"]);
    expect(LedgerEntry.safeParse({ ...e, txHashes: ["<script>"] }).success).toBe(false);
  });
});

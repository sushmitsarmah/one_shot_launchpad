import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { config, configVersion } from "./config";

const TGAS = 10n ** 12n;

// Built lazily so config (process.env or Worker bindings) is read at first use, not at module load.
let provider: JsonRpcProvider | null = null;
let relayer: Account | null = null;
let builtFor = -1;
function refresh() {
  if (builtFor !== configVersion()) {
    provider = null;
    relayer = null;
    builtFor = configVersion();
  }
}
function getProvider(): JsonRpcProvider {
  refresh();
  provider ??= new JsonRpcProvider({ url: config.rpcUrl });
  return provider;
}

function getRelayer(): Account {
  if (!config.relayerAccountId || !config.relayerPrivateKey) {
    throw new Error("RELAYER_ACCOUNT_ID / RELAYER_PRIVATE_KEY not set (or set NEAR_MOCK=1)");
  }
  const p = getProvider();
  relayer ??= new Account(config.relayerAccountId, p, config.relayerPrivateKey as KeyPairString);
  return relayer;
}

// In-memory ledger used only with NEAR_MOCK=1 so the API runs without testnet accounts.
const mockBalances = new Map<string, bigint>();
const mockHash = () => `mock${crypto.randomUUID().replace(/-/g, "")}`;
const mockBal = (a: string) => mockBalances.get(a) ?? 10n * 10n ** 24n; // 10 NEAR

export async function getVaultBalance(account: string): Promise<bigint> {
  if (config.nearMock) return mockBal(account);
  const v = await getProvider().callFunction<string>({
    contractId: config.vaultContract,
    method: "get_balance",
    args: { account_id: account },
  });
  return BigInt(v ?? "0");
}

export async function getRequiredLaunchDeposit(): Promise<bigint> {
  if (config.nearMock) return 2n * 10n ** 24n;
  const v = await getProvider().callFunction<string>({
    contractId: config.factoryContract,
    method: "get_required_deposit",
    args: {},
  });
  return BigInt(v ?? "0");
}

/** True if `publicKey` is a FullAccess key of `accountId` (false if the key or account doesn't exist). */
export async function isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
  try {
    const k = await getProvider().viewAccessKey({ accountId, publicKey });
    return k.permission === "FullAccess";
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|AccessKeyDoesNotExist|doesn't exist/i.test(msg)) return false;
    throw e;
  }
}

export async function accountExists(accountId: string): Promise<boolean> {
  if (config.nearMock) return false;
  try {
    await getProvider().viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

function decodeSuccessValue(status: unknown): unknown {
  const s = status as { SuccessValue?: string } | undefined;
  if (!s?.SuccessValue) return null;
  const bin = atob(s.SuccessValue);
  const txt = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  return txt ? JSON.parse(txt) : null;
}

export async function deductAiCompute(user: string, amount: bigint): Promise<string> {
  if (config.nearMock) {
    const b = mockBal(user);
    if (b < amount) throw new Error("insufficient balance");
    mockBalances.set(user, b - amount);
    return mockHash();
  }
  const r = await getRelayer().callFunctionRaw({
    contractId: config.vaultContract,
    methodName: "deduct_ai_compute",
    args: { user_id: user, amount: amount.toString() },
    gas: 30n * TGAS,
  });
  return r.transaction.hash;
}

export interface TokenArgs {
  ticker: string;
  name: string;
  symbol?: string;
  icon?: string | null;
  decimals?: number;
  total_supply: string;
  /** Compact site JSON stored with the factory record. */
  site?: string | null;
}

/** Factory registry record (see near-ft-factory TokenRecord). */
export interface TokenRecord {
  ticker: string;
  token_id: string;
  owner_id: string;
  created_at_ms: string;
  site: string | null;
}

const mockRecords: TokenRecord[] = [];

export async function isTickerTaken(ticker: string): Promise<boolean> {
  if (config.nearMock) return mockRecords.some((r) => r.ticker === ticker);
  const taken = await getProvider().callFunction<boolean>({
    contractId: config.factoryContract,
    method: "is_ticker_taken",
    args: { ticker },
  });
  // Tokens created before the v0.2 registry are not in it; the account check covers them.
  return Boolean(taken) || (await accountExists(`${ticker}.${config.factoryContract}`));
}

export async function getTokenRecord(ticker: string): Promise<TokenRecord | null> {
  if (config.nearMock) return mockRecords.find((r) => r.ticker === ticker) ?? null;
  const r = await getProvider().callFunction({
    contractId: config.factoryContract,
    method: "get_token",
    args: { ticker },
  });
  return (r as unknown as TokenRecord | null) ?? null;
}

export async function getTokensByOwner(owner: string, fromIndex = 0, limit = 50): Promise<TokenRecord[]> {
  if (config.nearMock) return mockRecords.filter((r) => r.owner_id === owner).reverse().slice(fromIndex, fromIndex + limit);
  const r = await getProvider().callFunction({
    contractId: config.factoryContract,
    method: "get_tokens_by_owner",
    args: { owner_id: owner, from_index: fromIndex, limit },
  });
  return (r as unknown as TokenRecord[] | null) ?? [];
}

interface VaultEvent {
  event: string;
  data: { ticker?: string; token_id?: string; account_id?: string };
}

/** NEP-297 events emitted by the vault across all receipts of a transaction. */
function vaultEvents(outcome: unknown): VaultEvent[] {
  const receipts = (outcome as { receipts_outcome?: { outcome: { executor_id: string; logs: string[] } }[] }).receipts_outcome ?? [];
  const out: VaultEvent[] = [];
  for (const r of receipts) {
    if (r.outcome.executor_id !== config.vaultContract) continue;
    for (const l of r.outcome.logs) {
      if (!l.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(l.slice(11));
        if (e.standard === "yeetpad_vault") out.push({ event: e.event, data: e.data?.[0] ?? {} });
      } catch {}
    }
  }
  return out;
}

export interface BatchItemResult {
  ticker: string;
  tokenId: string | null;
}

/** One vault call launching up to 5 tokens; per-item results come from launch/refund events. */
export async function executeSponsoredLaunchBatch(
  user: string,
  tokens: TokenArgs[],
  depositRequired: bigint,
): Promise<{ txHash: string; results: BatchItemResult[] }> {
  if (config.nearMock) {
    const b = mockBal(user);
    const total = depositRequired * BigInt(tokens.length);
    if (b < total) throw new Error("insufficient balance");
    mockBalances.set(user, b - total);
    const results = tokens.map((t) => {
      const token_id = `${t.ticker}.${config.factoryContract}`;
      mockRecords.push({ ticker: t.ticker, token_id, owner_id: user, created_at_ms: String(Date.now()), site: t.site ?? null });
      return { ticker: t.ticker, tokenId: token_id };
    });
    return { txHash: mockHash(), results };
  }
  const r = await getRelayer().callFunctionRaw({
    contractId: config.vaultContract,
    methodName: "execute_sponsored_launch_batch",
    args: { user_id: user, tokens, deposit_required: depositRequired.toString() },
    gas: 300n * TGAS,
  });
  const txHash = r.transaction.hash;
  let events = vaultEvents(r);
  const settled = () => events.filter((e) => e.event === "launch" || e.event === "refund").length;
  // Detached per-item promises may still be finishing; poll the final status briefly.
  for (let i = 0; i < 10 && settled() < tokens.length; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const st = await getProvider().viewTransactionStatusWithReceipts({
      txHash,
      accountId: config.relayerAccountId!,
      waitUntil: "FINAL",
    } as never);
    events = vaultEvents(st);
  }
  const results = tokens.map((t) => {
    const ok = events.find((e) => e.event === "launch" && e.data.ticker === t.ticker);
    return { ticker: t.ticker, tokenId: ok?.data.token_id ?? null };
  });
  return { txHash, results };
}

export async function executeSponsoredLaunch(
  user: string,
  token: TokenArgs,
  depositRequired: bigint,
): Promise<{ tokenId: string | null; txHash: string }> {
  if (config.nearMock) {
    const b = mockBal(user);
    if (b < depositRequired) throw new Error("insufficient balance");
    mockBalances.set(user, b - depositRequired);
    const token_id = `${token.ticker}.${config.factoryContract}`;
    mockRecords.push({ ticker: token.ticker, token_id, owner_id: user, created_at_ms: String(Date.now()), site: token.site ?? null });
    return { tokenId: token_id, txHash: mockHash() };
  }
  const r = await getRelayer().callFunctionRaw({
    contractId: config.vaultContract,
    methodName: "execute_sponsored_launch",
    args: { user_id: user, token, deposit_required: depositRequired.toString() },
    gas: 300n * TGAS,
  });
  const tokenId = decodeSuccessValue(r.status) as string | null;
  return { tokenId, txHash: r.transaction.hash };
}

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
    return { tokenId: `${token.ticker}.${config.factoryContract}`, txHash: mockHash() };
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

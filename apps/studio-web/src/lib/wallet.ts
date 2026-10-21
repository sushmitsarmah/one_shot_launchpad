import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { actionCreators } from "@near-js/transactions";
import { NETWORK, VAULT_CONTRACT } from "./config";

let ready: Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> | null = null;

export function initWallet() {
  ready ??= (async () => {
    const selector = await setupWalletSelector({
      network: NETWORK,
      modules: [setupMyNearWallet(), setupMeteorWallet(), setupHereWallet()],
    });
    const modal = setupModal(selector, { contractId: VAULT_CONTRACT });
    return { selector, modal };
  })();
  return ready;
}

/** Calls `deposit_credits` on the vault with `yocto` attached. */
export async function depositCredits(yocto: string) {
  const { selector } = await initWallet();
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    receiverId: VAULT_CONTRACT,
    actions: [actionCreators.functionCall("deposit_credits", {}, 30_000_000_000_000n, BigInt(yocto))],
  });
}

export interface PreparedCall {
  ticker: string;
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}

export const NEARLY_PENDING = "yeetpad.nearlyPending";

/**
 * Signs one transaction per call with signAndSendTransactions, `chunk` per wallet prompt.
 * Redirect wallets (MyNearWallet) leave the page: the tickers are kept in localStorage and the
 * hashes come back in `?transactionHashes=` (see takeRedirectedNearly).
 */
export async function signCallsInChunks(calls: PreparedCall[], chunk: number, onChunk?: (done: number) => void) {
  const { selector } = await initWallet();
  const wallet = await selector.wallet();
  const out: { ticker: string; txHash: string }[] = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const part = calls.slice(i, i + chunk);
    localStorage.setItem(NEARLY_PENDING, JSON.stringify(part.map((c) => c.ticker)));
    const res = await wallet.signAndSendTransactions({
      transactions: part.map((c) => ({
        receiverId: c.receiverId,
        actions: [actionCreators.functionCall(c.methodName, c.args, BigInt(c.gas), BigInt(c.deposit))],
      })),
    });
    const outcomes = (res ?? []) as { transaction?: { hash?: string } }[];
    outcomes.forEach((o, k) => o?.transaction?.hash && out.push({ ticker: part[k].ticker, txHash: o.transaction.hash }));
    localStorage.removeItem(NEARLY_PENDING);
    onChunk?.(Math.min(i + chunk, calls.length));
  }
  return out;
}

/** After a redirect wallet returns: pairs pending tickers with `transactionHashes` (same order). */
export function takeRedirectedNearly(): { ticker: string; txHash: string }[] {
  const pending = JSON.parse(localStorage.getItem(NEARLY_PENDING) ?? "[]") as string[];
  const u = new URL(location.href);
  const hashes = (u.searchParams.get("transactionHashes") ?? "").split(",").filter(Boolean);
  if (!pending.length || !hashes.length) return [];
  localStorage.removeItem(NEARLY_PENDING);
  u.searchParams.delete("transactionHashes");
  history.replaceState(null, "", u.toString());
  return pending.slice(0, hashes.length).map((ticker, i) => ({ ticker, txHash: hashes[i] }));
}

export async function signOut() {
  const { clearSession } = await import("./auth");
  clearSession();
  const { selector } = await initWallet();
  const wallet = await selector.wallet();
  await wallet.signOut();
}

import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { actionCreators } from "@near-js/transactions";
import { NETWORK, VAULT_CONTRACT } from "./config";

let ready: Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> | null = null;

export function initWallet() {
  ready ??= (async () => {
    // One module list for both networks (PUBLIC_NETWORK picks testnet/mainnet). Intear Wallet
    // (wallet.intear.tech) is popup-based: signMessage + signAndSendTransactions return inline, no redirect.
    const selector = await setupWalletSelector({
      network: NETWORK,
      modules: [setupMyNearWallet(), setupMeteorWallet(), setupHereWallet(), setupIntearWallet()],
    });
    // No contractId: signing in must not add a limited access key to the user's account. Yeetpad never
    // uses one (every user tx carries a deposit, so it needs the wallet's approval anyway), and wallets
    // like Meteor then make sign-out a key-removal transaction. Sign-in proof is the NEP-413 message.
    const modal = setupModal(selector, {});
    return { selector, modal };
  })();
  return ready;
}

/**
 * Popup wallets (Intear, MyNearWallet popup) surface raw errors like "Popup was blocked" / "Popup closed";
 * turn those into something a user can act on. Other errors pass through unchanged.
 */
export function friendlyWalletError(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (/popup was blocked/i.test(err.message))
    return new Error("Your browser blocked the wallet popup. Allow popups for this site, then click again.");
  if (/^popup closed$/i.test(err.message.trim())) return new Error("The wallet window was closed before you approved. Nothing was signed; try again.");
  return err;
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
export type WalletVenue = "nearly" | "justhoot";
export interface SignOpts {
  /** Called before each wallet prompt: approval `k` of `of` (1-based). */
  onPrompt?: (k: number, of: number) => void;
  /** Called after each prompt with that prompt's signed txs (finalize/persist them right away). */
  onSigned?: (part: { ticker: string; txHash: string }[], doneCalls: number) => void | Promise<void>;
  /** Remember the tickers for a redirect wallet's return (Nearly/JustHoot finalize). Off for other calls. */
  persist?: boolean;
}
export async function signCallsInChunks(calls: PreparedCall[], chunk: number, opts: SignOpts | ((done: number) => void) = {}, venue: WalletVenue = "nearly") {
  const o: SignOpts = typeof opts === "function" ? { onSigned: (_p, n) => opts(n) } : opts;
  const { selector } = await initWallet();
  const wallet = await selector.wallet();
  const out: { ticker: string; txHash: string }[] = [];
  const size = Math.max(1, chunk);
  const prompts = Math.ceil(calls.length / size);
  for (let i = 0, k = 1; i < calls.length; i += size, k++) {
    const part = calls.slice(i, i + size);
    o.onPrompt?.(k, prompts);
    if (o.persist !== false) localStorage.setItem(NEARLY_PENDING, JSON.stringify({ venue, tickers: part.map((c) => c.ticker) }));
    const res = await wallet.signAndSendTransactions({
      transactions: part.map((c) => ({
        receiverId: c.receiverId,
        actions: [actionCreators.functionCall(c.methodName, c.args, BigInt(c.gas), BigInt(c.deposit))],
      })),
    });
    const outcomes = (res ?? []) as { transaction?: { hash?: string } }[];
    const signed: { ticker: string; txHash: string }[] = [];
    outcomes.forEach((x, j) => x?.transaction?.hash && signed.push({ ticker: part[j].ticker, txHash: x.transaction.hash }));
    out.push(...signed);
    if (o.persist !== false) localStorage.removeItem(NEARLY_PENDING);
    await o.onSigned?.(signed, Math.min(i + size, calls.length));
  }
  return out;
}

/** After a redirect wallet returns: pairs pending tickers with `transactionHashes` (same order). */
export function takeRedirectedNearly(): { venue: WalletVenue; items: { ticker: string; txHash: string }[] } {
  const raw = JSON.parse(localStorage.getItem(NEARLY_PENDING) ?? "[]") as string[] | { venue: WalletVenue; tickers: string[] };
  const venue: WalletVenue = Array.isArray(raw) ? "nearly" : raw.venue;
  const pending = Array.isArray(raw) ? raw : raw.tickers;
  const u = new URL(location.href);
  const hashes = (u.searchParams.get("transactionHashes") ?? "").split(",").filter(Boolean);
  if (!pending.length || !hashes.length) return { venue, items: [] };
  localStorage.removeItem(NEARLY_PENDING);
  u.searchParams.delete("transactionHashes");
  history.replaceState(null, "", u.toString());
  return { venue, items: pending.slice(0, hashes.length).map((ticker, i) => ({ ticker, txHash: hashes[i] })) };
}

export const RELIST_PENDING = "yeetpad.relistPending";

/**
 * Hands a Yeetpad token the user holds to the vault for a Rhea listing: registers the vault on the
 * token (no-op refund if already registered) and `ft_transfer_call(vault, amount, "list_on_rhea")`.
 * Returns false when a redirect wallet left the page (finish with takeRedirectedRelist on return).
 */
export async function sendForRelist(tokenId: string, amount: string): Promise<boolean> {
  const { selector } = await initWallet();
  const wallet = await selector.wallet();
  localStorage.setItem(RELIST_PENDING, tokenId);
  const res = await wallet.signAndSendTransaction({
    receiverId: tokenId,
    actions: [
      actionCreators.functionCall("storage_deposit", { account_id: VAULT_CONTRACT, registration_only: true }, 10_000_000_000_000n, 1_250_000_000_000_000_000_000n),
      actionCreators.functionCall("ft_transfer_call", { receiver_id: VAULT_CONTRACT, amount, msg: "list_on_rhea" }, 60_000_000_000_000n, 1n),
    ],
  });
  if (!res) return false;
  localStorage.removeItem(RELIST_PENDING);
  return true;
}

export function takeRedirectedRelist(): string | null {
  const t = localStorage.getItem(RELIST_PENDING);
  if (!t || !new URL(location.href).searchParams.get("transactionHashes")) return null;
  localStorage.removeItem(RELIST_PENDING);
  return t;
}

export async function signOut() {
  const { clearSession } = await import("./auth");
  clearSession();
  const { selector } = await initWallet();
  const wallet = await selector.wallet();
  await wallet.signOut();
}

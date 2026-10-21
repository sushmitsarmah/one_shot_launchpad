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

export async function signOut() {
  const { clearSession } = await import("./auth");
  clearSession();
  const { selector } = await initWallet();
  const wallet = await selector.wallet();
  await wallet.signOut();
}

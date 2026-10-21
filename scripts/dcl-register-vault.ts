// One-time: the deployer sponsors the vault's Rhea DCL storage (0.5 NEAR minimum on testnet and mainnet),
// so the vault can hold a position for the moment between add_liquidity and nft_transfer to the creator.
import { master, provider, VAULT_ID } from "./lib";
const DCL = process.env.DCL_CONTRACT || (VAULT_ID.endsWith(".testnet") ? "dclv2.ref-dev.testnet" : "dclv2.ref-labs.near");
const have = await provider.callFunction({ contractId: DCL, method: "storage_balance_of", args: { account_id: VAULT_ID } });
if (have) {
  console.log(`vault already registered on ${DCL}:`, JSON.stringify(have));
} else {
  const r = await master.callFunctionRaw({
    contractId: DCL,
    methodName: "storage_deposit",
    args: { account_id: VAULT_ID, registration_only: false },
    deposit: 5n * 10n ** 23n,
    gas: 30n * 10n ** 12n,
  });
  console.log(`registered ${VAULT_ID} on ${DCL}: ${r.transaction.hash}`);
}

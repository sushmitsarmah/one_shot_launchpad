// Deploys near-launch-vault to VAULT_ACCOUNT_ID (default launch-vault.<NEAR_ACCOUNT_ID>),
// inits it with the factory + relayer, or (if already initialized) ensures the relayer is added.
import { FACTORY_ID, MASTER_ID, VAULT_ID, ensureSubAccountWithCode, isInitialized, master, opt, provider, wasm } from "./lib";

const relayer = opt("RELAYER_ACCOUNT_ID", MASTER_ID);
const feeBps = Number(opt("PLATFORM_FEE_BPS", "0"));

const acc = await ensureSubAccountWithCode(VAULT_ID, opt("VAULT_INITIAL_BALANCE", "3"), wasm("near_launch_vault"));
if (await isInitialized(VAULT_ID, "get_config")) {
  console.log("vault already initialized; ensuring relayer");
  // Owner is MASTER_ID (set at init below).
  await master.callFunction({ contractId: VAULT_ID, methodName: "add_relayer", args: { account_id: relayer } });
} else {
  await acc.callFunction({
    contractId: VAULT_ID,
    methodName: "new",
    args: { owner_id: MASTER_ID, ft_factory: FACTORY_ID, platform_fee_bps: feeBps, relayers: [relayer] },
  });
  console.log("vault initialized");
}
console.log("config:", await provider.callFunction({ contractId: VAULT_ID, method: "get_config", args: {} }));
console.log("relayers:", await provider.callFunction({ contractId: VAULT_ID, method: "get_relayers", args: {} }));
console.log(`\nSet in apps/orchestrator-api/.env:\n  VAULT_CONTRACT=${VAULT_ID}\n  FT_FACTORY_CONTRACT=${FACTORY_ID}\n  RELAYER_ACCOUNT_ID=${relayer}`);
console.log(`Set in Cloudflare Pages env:\n  PUBLIC_VAULT_CONTRACT=${VAULT_ID}`);

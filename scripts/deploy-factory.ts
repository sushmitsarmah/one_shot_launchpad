// Deploys near-ft-factory to FT_FACTORY_ACCOUNT_ID (default ft-factory.<NEAR_ACCOUNT_ID>) and inits it.
import { FACTORY_ID, MASTER_ID, ensureSubAccountWithCode, isInitialized, opt, provider, wasm } from "./lib";

const acc = await ensureSubAccountWithCode(FACTORY_ID, opt("FACTORY_INITIAL_BALANCE", "5"), wasm("near_ft_factory"));
if (await isInitialized(FACTORY_ID, "get_owner")) {
  console.log("factory already initialized");
} else {
  await acc.callFunction({ contractId: FACTORY_ID, methodName: "new", args: { owner_id: MASTER_ID } });
  console.log("factory initialized");
}
const dep = await provider.callFunction({ contractId: FACTORY_ID, method: "get_required_deposit", args: {} });
console.log(`factory ready: ${FACTORY_ID} (required launch deposit ${dep} yocto)`);

// Upgrades the deployed factory + vault in place: deploys contracts/res/*.wasm with the parent
// account's key (sub-accounts are created with it) and calls `migrate`, which keeps all state.
// Later upgrades can also use the owner-only `update_contract` method (wasm as raw input).
import { Account } from "near-api-js";
import { FACTORY_ID, MASTER_KEY, VAULT_ID, provider, wasm } from "./lib";

for (const [id, name] of [[FACTORY_ID, "near_ft_factory"], [VAULT_ID, "near_launch_vault"]] as const) {
  const acc = new Account(id, provider, MASTER_KEY);
  const d = await acc.deployContract(wasm(name));
  console.log(`deployed ${name} to ${id}: ${d.transaction.hash}`);
  const m = await acc.callFunctionRaw({ contractId: id, methodName: "migrate", args: {}, gas: 100n * 10n ** 12n });
  console.log(`  migrate: ${m.transaction.hash}`);
}

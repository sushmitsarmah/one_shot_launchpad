// Mainnet deploy for Yeetpad. Dry-run by default: reads chain state (view calls only) and prints every step,
// its cost and the balances it needs. Nothing is signed or sent unless you pass --execute.
//
//   bun scripts/deploy-mainnet.ts               # dry run (safe; read-only RPC)
//   bun scripts/deploy-mainnet.ts --execute     # send the transactions, step by step; re-run is a no-op
//   flags: --no-global (skip publishing the global token code), --root=yeetpad.near, --rpc=<url>
//
// Idempotent: every step checks chain state first (account exists, code hash matches, initialized,
// global token set, DCL storage registered) and is skipped when already done.
//
// Keys (never printed):
//   DEPLOYER_KEY_FILE   default ~/.secrets/near_mainnet_yeetpad_294bca9c.json  ({account_id, public_key, private_key})
//                       Its key becomes the full-access (owner) key of yeetpad.near, factory.* and vault.*.
//   RELAYER_KEY_FILE    default ~/.secrets/near_mainnet_relayer_yeetpad.json  (generated locally if missing).
//                       A separate key for relayer.<root>; this is what the API worker holds (RELAYER_PRIVATE_KEY).
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const EXECUTE = args.includes("--execute");
const GLOBAL = !args.includes("--no-global");
const RPC = arg("rpc", process.env.NEAR_RPC_URL || "https://rpc.mainnet.fastnear.com");
const ROOT = arg("root", "yeetpad.near");
const FACTORY = `factory.${ROOT}`;
const VAULT = `vault.${ROOT}`;
const RELAYER = `relayer.${ROOT}`;
const DCL = "dclv2.ref-labs.near";
const WNEAR = "wrap.near";
if (!ROOT.endsWith(".near")) throw new Error("mainnet only: --root must end with .near");

const SECRETS = resolve(homedir(), ".secrets");
const DEPLOYER_KEY_FILE = process.env.DEPLOYER_KEY_FILE || resolve(SECRETS, "near_mainnet_yeetpad_294bca9c.json");
const RELAYER_KEY_FILE = process.env.RELAYER_KEY_FILE || resolve(SECRETS, "near_mainnet_relayer_yeetpad.json");
const SESSION_SECRET_FILE = resolve(SECRETS, "yeetpad_mainnet_session_secret");

// ---- amounts (NEAR). Storage is priced from the live protocol config below. ----
const Y = 10n ** 24n;
const near = (s: string) => {
  const [i, f = ""] = s.split(".");
  return BigInt(i) * Y + BigInt((f + "0".repeat(24)).slice(0, 24));
};
const fmt = (y: bigint) => {
  const neg = y < 0n;
  const a = neg ? -y : y;
  return `${neg ? "-" : ""}${a / Y}.${(a % Y).toString().padStart(24, "0").slice(0, 5)}`;
};
const ACCOUNT_BYTES = 100n + 82n; // account record + one ed25519 full-access key
const FACTORY_STATE_BYTES = 600n; // owner, counters, global hash (observed ~300 on testnet)
const VAULT_STATE_BYTES = 1000n; // owner, factory, dcl, wnear, 1 relayer, collections
const GLOBAL_FACTOR = 10n; // NEP-591: global code costs 10x storage, burned (confirmed on testnet: 16.6503 NEAR)
const BUFFER = { root: near("0.2"), factory: near("0.1"), vault: near("0.2"), relayer: near("1"), deployerKeep: near("0.01") };
const DCL_STORAGE = near("0.5"); // Rhea DCL minimum storage_deposit for the vault
const GAS = { tx: near("0.002"), deploy: near("0.005"), publish: near("0.003") }; // testnet: publish burnt 0.00208 gas

// ---- helpers ----
const provider = new JsonRpcProvider({ url: RPC });
const rpc = async (method: string, params: unknown) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: any; error?: any };
};
const viewAccount = async (id: string) => {
  const r = await rpc("query", { request_type: "view_account", finality: "final", account_id: id });
  return r.result as { amount: string; locked: string; code_hash: string; storage_usage: number; global_contract_hash?: string } | undefined;
};
const view = async (id: string, method: string, a: Record<string, unknown> = {}) => {
  try {
    return await provider.callFunction({ contractId: id, method, args: a });
  } catch {
    return undefined;
  }
};
const wasm = (name: string) => {
  const p = resolve(import.meta.dir, "../contracts/res", `${name}.wasm`);
  if (!existsSync(p)) throw new Error(`${p} missing: bun run contracts:build`);
  return new Uint8Array(readFileSync(p));
};
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf: Uint8Array) => {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) if (b === 0) s = "1" + s; else break;
  return s;
};
const sha = (b: Uint8Array) => b58(createHash("sha256").update(b).digest());

function loadKey(file: string): { account_id?: string; public_key: string; private_key: KeyPairString } {
  if (!existsSync(file)) throw new Error(`key file not found: ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}
function ensureLocalSecret(file: string, make: () => string, what: string) {
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, make());
  chmodSync(file, 0o600);
  console.log(`  generated ${what} at ${file} (local only, chmod 600, not printed)`);
  return true;
}

// ---- plan ----
type Step = { name: string; done: boolean; cost: bigint; burn?: bigint; note: string; run: () => Promise<string | void> };
const steps: Step[] = [];

const deployerKey = loadKey(DEPLOYER_KEY_FILE);
const DEPLOYER = deployerKey.account_id!;
const pub = KeyPair.fromString(deployerKey.private_key).getPublicKey();
if (Buffer.from(pub.data).toString("hex") !== DEPLOYER) throw new Error("deployer key does not match its implicit account id");
ensureLocalSecret(RELAYER_KEY_FILE, () => {
  const kp = KeyPair.fromRandom("ed25519");
  return JSON.stringify({ account_id: RELAYER, public_key: kp.getPublicKey().toString(), private_key: kp.toString() });
}, "relayer key");
ensureLocalSecret(SESSION_SECRET_FILE, () => createHash("sha256").update(crypto.getRandomValues(new Uint8Array(64))).digest("hex"), "mainnet SESSION_SECRET");
const relayerPub = loadKey(RELAYER_KEY_FILE).public_key;

const cfg = (await rpc("EXPERIMENTAL_protocol_config", { finality: "final" })).result;
const PER_BYTE = BigInt(cfg.runtime_config.storage_amount_per_byte);
if (!cfg.runtime_config.wasm_config.global_contract_host_fns) console.warn("WARNING: global contract host fns not enabled on this network");
const status = (await rpc("status", [])).result;
if (status.chain_id !== "mainnet") throw new Error(`RPC is ${status.chain_id}, expected mainnet`);

const factoryWasm = wasm("near_ft_factory");
const vaultWasm = wasm("near_launch_vault");
const tokenWasm = wasm("near_ft_token");
const tokenHash = sha(tokenWasm);
const storage = (bytes: bigint) => bytes * PER_BYTE;

const [dAcc, rAcc, fAcc, vAcc, relAcc] = await Promise.all([DEPLOYER, ROOT, FACTORY, VAULT, RELAYER].map(viewAccount));
const signer = (id: string) => new Account(id, provider, deployerKey.private_key);

const rootFund = storage(ACCOUNT_BYTES) + DCL_STORAGE + BUFFER.root + 6n * GAS.tx;
const factoryFund = storage(ACCOUNT_BYTES + BigInt(factoryWasm.length) + FACTORY_STATE_BYTES) + BUFFER.factory + (GLOBAL ? BigInt(tokenWasm.length) * PER_BYTE * GLOBAL_FACTOR + GAS.publish : 0n);
const vaultFund = storage(ACCOUNT_BYTES + BigInt(vaultWasm.length) + VAULT_STATE_BYTES) + BUFFER.vault;
const relayerFund = storage(ACCOUNT_BYTES) + BUFFER.relayer;

steps.push({
  name: `create ${ROOT} (via the 'near' registrar) and fund it`,
  done: !!rAcc,
  cost: rAcc ? 0n : rootFund + factoryFund + vaultFund + relayerFund + GAS.tx,
  note: `transfers everything the sub-accounts need: root ${fmt(rootFund)} + factory ${fmt(factoryFund)} + vault ${fmt(vaultFund)} + relayer ${fmt(relayerFund)}`,
  run: async () => (await signer(DEPLOYER).createAccount({ newAccountId: ROOT, publicKey: pub, nearToTransfer: rootFund + factoryFund + vaultFund + relayerFund })).transaction.hash,
});
const sub = (id: string, fund: bigint, key: string, have: unknown) =>
  steps.push({
    name: `create ${id}`,
    done: !!have,
    cost: 0n,
    note: `${fmt(fund)} NEAR from ${ROOT}`,
    run: async () => (await signer(ROOT).createSubAccount({ accountOrPrefix: id, publicKey: key, nearToTransfer: fund })).transaction.hash,
  });
sub(FACTORY, factoryFund, pub.toString(), fAcc);
sub(VAULT, vaultFund, pub.toString(), vAcc);
sub(RELAYER, relayerFund, relayerPub, relAcc);

const codeOk = (a: Awaited<ReturnType<typeof viewAccount>>, code: Uint8Array) => a?.code_hash === sha(code);
steps.push({ name: `deploy factory code (${factoryWasm.length} B, ${sha(factoryWasm)})`, done: codeOk(fAcc, factoryWasm), cost: GAS.deploy, note: `locks ${fmt(storage(BigInt(factoryWasm.length)))} NEAR of factory balance`, run: async () => (await signer(FACTORY).deployContract(factoryWasm)).transaction.hash });
steps.push({ name: "init factory new(owner_id)", done: !!(await view(FACTORY, "get_owner")), cost: GAS.tx, note: `owner ${ROOT}`, run: async () => (await signer(FACTORY).callFunctionRaw({ contractId: FACTORY, methodName: "new", args: { owner_id: ROOT }, gas: 30n * 10n ** 12n })).transaction.hash });
steps.push({ name: `deploy vault code (${vaultWasm.length} B, ${sha(vaultWasm)})`, done: codeOk(vAcc, vaultWasm), cost: GAS.deploy, note: `locks ${fmt(storage(BigInt(vaultWasm.length)))} NEAR of vault balance`, run: async () => (await signer(VAULT).deployContract(vaultWasm)).transaction.hash });
const vaultCfg = (await view(VAULT, "get_config")) as Record<string, unknown> | undefined;
steps.push({
  name: "init vault new(owner, ft_factory, fee 0, relayers)",
  done: !!vaultCfg,
  cost: GAS.tx,
  note: `owner ${ROOT}, factory ${FACTORY}, relayer ${RELAYER}; dcl/wnear default to ${DCL}/${WNEAR} on .near`,
  run: async () => (await signer(VAULT).callFunctionRaw({ contractId: VAULT, methodName: "new", args: { owner_id: ROOT, ft_factory: FACTORY, platform_fee_bps: 0, relayers: [RELAYER] }, gas: 30n * 10n ** 12n })).transaction.hash,
});
const relayers = ((await view(VAULT, "get_relayers")) as string[] | undefined) ?? [];
steps.push({ name: `ensure ${RELAYER} is a vault relayer`, done: relayers.includes(RELAYER) || !vaultCfg, cost: vaultCfg && !relayers.includes(RELAYER) ? GAS.tx : 0n, note: "covered by init on a fresh deploy", run: async () => (await signer(ROOT).callFunctionRaw({ contractId: VAULT, methodName: "add_relayer", args: { account_id: RELAYER }, gas: 30n * 10n ** 12n })).transaction.hash });

const fCfg = (await view(FACTORY, "get_config")) as { global_token?: string | null } | undefined;
const globalSet = !!fCfg?.global_token;
const globalExists = !!(await rpc("query", { request_type: "view_global_contract_code", finality: "final", code_hash: tokenHash })).result;
const globalBurn = BigInt(tokenWasm.length) * PER_BYTE * GLOBAL_FACTOR;
if (GLOBAL) {
  steps.push({
    name: `publish global token code (${tokenWasm.length} B, ${tokenHash})`,
    done: globalExists || globalSet,
    cost: GAS.publish,
    burn: globalBurn,
    note: `factory.publish_global_token(): burns ${fmt(globalBurn)} NEAR from the factory balance (10x storage, not refundable)`,
    run: async () => (await signer(ROOT).callFunctionRaw({ contractId: FACTORY, methodName: "publish_global_token", args: {}, gas: 300n * 10n ** 12n })).transaction.hash,
  });
  steps.push({ name: "factory.set_global_token(hash)", done: globalSet, cost: GAS.tx, note: "launch deposit drops from ~1.82 to ~0.076 NEAR", run: async () => (await signer(ROOT).callFunctionRaw({ contractId: FACTORY, methodName: "set_global_token", args: { code_hash: tokenHash }, gas: 30n * 10n ** 12n })).transaction.hash });
}
const dclReg = vAcc ? await view(DCL, "storage_balance_of", { account_id: VAULT }) : undefined;
steps.push({
  name: `register vault on Rhea DCL (${DCL}.storage_deposit)`,
  done: !!dclReg,
  cost: GAS.tx,
  note: `${fmt(DCL_STORAGE)} NEAR from ${ROOT} (held by DCL as the vault's storage)`,
  run: async () => (await signer(ROOT).callFunctionRaw({ contractId: DCL, methodName: "storage_deposit", args: { account_id: VAULT, registration_only: false }, deposit: DCL_STORAGE, gas: 30n * 10n ** 12n })).transaction.hash,
});

// ---- report ----
console.log(`\nYeetpad mainnet deploy  ${EXECUTE ? "EXECUTE" : "DRY RUN (read-only; pass --execute to send)"}`);
console.log(`rpc ${RPC} · protocol ${cfg.protocol_version} · storage ${fmt(PER_BYTE * 100000n)} NEAR/100kB · global code ${GLOBAL ? "on" : "off"}`);
console.log(`deployer ${DEPLOYER.slice(0, 8)}…${DEPLOYER.slice(-6)}  balance ${dAcc ? fmt(BigInt(dAcc.amount)) : "0 (account not created yet: send NEAR to it)"}`);
for (const [id, a] of [[ROOT, rAcc], [FACTORY, fAcc], [VAULT, vAcc], [RELAYER, relAcc]] as const)
  console.log(`  ${id.padEnd(22)} ${a ? `${fmt(BigInt(a.amount))} NEAR, ${a.storage_usage} B, code ${a.code_hash.slice(0, 8)}` : "does not exist"}`);

console.log("\nBudget (NEAR)");
const rows: [string, bigint][] = [
  [`${ROOT} account + DCL storage 0.5 + buffer`, rootFund],
  [`${FACTORY}: code ${factoryWasm.length} B + state + buffer`, factoryFund - (GLOBAL ? globalBurn + GAS.publish : 0n)],
  ...(GLOBAL ? ([[`global token code ${tokenWasm.length} B x10 (burned)`, globalBurn + GAS.publish]] as [string, bigint][]) : []),
  [`${VAULT}: code ${vaultWasm.length} B + state + buffer`, vaultFund],
  [`${RELAYER}: account + gas float`, relayerFund],
  ["gas for create/deploy/init txs", steps.reduce((s, x) => s + x.cost, 0n) - (steps[0].done ? 0n : rootFund + factoryFund + vaultFund + relayerFund)],
  ["keep on deployer (implicit account storage)", BUFFER.deployerKeep],
];
let total = 0n;
for (const [k, v] of rows) {
  total += v;
  console.log(`  ${fmt(v).padStart(10)}  ${k}`);
}
console.log(`  ${fmt(total).padStart(10)}  TOTAL needed on the deployer`);
const bal = dAcc ? BigInt(dAcc.amount) : 0n;
console.log(`  ${fmt(bal - total).padStart(10)}  deployer balance minus total${bal < total ? "  (NOT ENOUGH YET)" : ""}`);

console.log("\nSteps");
let n = 0;
for (const s of steps) {
  n++;
  const tag = s.done ? "skip (done)" : EXECUTE ? "run" : "would run";
  console.log(`  ${String(n).padStart(2)}. [${tag}] ${s.name} · ${s.note}`);
  if (s.done || !EXECUTE) continue;
  try {
    const tx = await s.run();
    console.log(`      tx ${tx}`);
  } catch (e) {
    console.error(`      FAILED: ${(e as Error).message.slice(0, 300)}\n  Fix and re-run; finished steps are skipped.`);
    process.exit(1);
  }
}
if (EXECUTE && !steps[0].done && bal < total) console.warn("balance was below the planned total");

console.log(`\nNext (see docs/mainnet-deploy.md):
  API worker secrets (--env mainnet), from local files, never echoed:
    RELAYER_PRIVATE_KEY  <- ${RELAYER_KEY_FILE} (.private_key)
    SESSION_SECRET       <- ${SESSION_SECRET_FILE}
    NEARAI_API_KEY       <- same provider key as testnet
  vars: NEAR_NETWORK=mainnet VAULT_CONTRACT=${VAULT} FT_FACTORY_CONTRACT=${FACTORY} RELAYER_ACCOUNT_ID=${RELAYER} AUTH_RECIPIENT=${VAULT}`);

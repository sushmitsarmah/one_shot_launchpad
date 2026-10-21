/**
 * Add (or with --remove, drop) NEAR accounts in the API's access allowlist:
 * edits `ALLOWED_ACCOUNTS` in apps/orchestrator-api/wrangler.jsonc. Deploy afterwards to apply:
 *
 *   bun run allow you.testnet && bun run deploy:api
 *   bun run allow --remove you.testnet && bun run deploy:api
 *   bun run allow --list
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../apps/orchestrator-api/wrangler.jsonc", import.meta.url));
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const LINE_RE = /("ALLOWED_ACCOUNTS"\s*:\s*")([^"]*)(")/;

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const list = args.includes("--list");
const accounts = args.filter((a) => !a.startsWith("--")).map((a) => a.trim().toLowerCase());

const src = readFileSync(FILE, "utf8");
const m = LINE_RE.exec(src);
if (!m) throw new Error(`"ALLOWED_ACCOUNTS" not found in ${FILE}`);
let current = m[2].split(",").map((s) => s.trim()).filter(Boolean);

if (list || accounts.length === 0) {
  console.log(current.join("\n") || "(allowlist is empty)");
  if (!list) console.log("\nusage: bun run allow [--remove] <account.testnet> [...]");
  process.exit(0);
}
for (const a of accounts) {
  if (a.length < 2 || a.length > 64 || !ACCOUNT_RE.test(a)) throw new Error(`invalid NEAR account id: ${a}`);
}
current = remove ? current.filter((a) => !accounts.includes(a)) : [...new Set([...current, ...accounts])];
writeFileSync(FILE, src.replace(LINE_RE, `$1${current.join(",")}$3`));
console.log(`ALLOWED_ACCOUNTS = ${current.join(",") || "(empty)"}\nNow deploy: bun run deploy:api`);

/**
 * Allowlist accounts directly in KV (same as approving them in Studio → Admin). Takes effect within ~30 s,
 * no redeploy. Runs `wrangler kv` against the SITES namespace (needs CLOUDFLARE_API_TOKEN or `wrangler login`).
 *
 *   bun run allow you.testnet [other.testnet ...]
 *   bun run allow --remove you.testnet      # revoke (waitlist request, if any, is left alone)
 *   bun run allow --list                    # KV approvals (env/admin accounts are in wrangler.jsonc)
 */
import { fileURLToPath } from "node:url";

const API_DIR = fileURLToPath(new URL("../apps/orchestrator-api/", import.meta.url));
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function wrangler(...args: string[]): string {
  const r = Bun.spawnSync(["npx", "-y", "wrangler@4.86.0", "kv", "key", ...args, "--binding", "SITES", "--remote"], { cwd: API_DIR, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`wrangler kv key ${args[0]} failed:\n${r.stderr.toString()}`);
  return r.stdout.toString();
}

const args = process.argv.slice(2);
const accounts = args.filter((a) => !a.startsWith("--")).map((a) => a.trim().toLowerCase());

if (args.includes("--list") || accounts.length === 0) {
  const keys = JSON.parse(wrangler("list", "--prefix", "allow:")) as { name: string; metadata?: { approvedAt?: number; approvedBy?: string } }[];
  for (const k of keys) {
    const m = k.metadata ?? {};
    console.log(`${k.name.slice(6)}${m.approvedBy ? `  (by ${m.approvedBy}${m.approvedAt ? `, ${new Date(m.approvedAt).toISOString()}` : ""})` : ""}`);
  }
  if (!keys.length) console.log("(no KV approvals)");
  if (!args.includes("--list")) console.log("\nusage: bun run allow [--remove] <account.testnet> [...]");
  process.exit(0);
}
for (const a of accounts) {
  if (a.length < 2 || a.length > 64 || !ACCOUNT_RE.test(a)) throw new Error(`invalid NEAR account id: ${a}`);
}
for (const a of accounts) {
  if (args.includes("--remove")) {
    wrangler("delete", `allow:${a}`);
    console.log(`revoked ${a}`);
  } else {
    const v = JSON.stringify({ approvedAt: Date.now(), approvedBy: "cli" });
    wrangler("put", `allow:${a}`, v, "--metadata", v);
    console.log(`allowed ${a} (live within ~30 s)`);
  }
}

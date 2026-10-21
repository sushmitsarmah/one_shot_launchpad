/**
 * Cloudflare Worker entry. Config comes from the Worker env bindings (wrangler.jsonc `vars`
 * + `wrangler secret put` secrets), applied once per isolate on the first request.
 * The local Bun server still uses src/index.ts with process.env.
 */
import type { ExecutionContext } from "hono";
import { app } from "./app";
import { configureFromEnv, type EnvSource } from "./config";
import { setSiteStore, type KVLike } from "./sites";

let configured = false;

export default {
  fetch(request: Request, env: EnvSource, ctx: ExecutionContext) {
    if (!configured) {
      configureFromEnv(env);
      setSiteStore(env.SITES as KVLike | undefined); // KV namespace yeetpad-sites
      configured = true;
    }
    return app.fetch(request, env, ctx);
  },
};

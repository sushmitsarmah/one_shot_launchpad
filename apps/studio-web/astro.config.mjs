import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Static build. Deployed via Cloudflare Workers static assets (see /wrangler.jsonc).
// Wallet SDKs still expect Node globals (Buffer, process, crypto) in the browser, hence the polyfills.
export default defineConfig({
  output: "static",
  integrations: [react()],
  vite: {
    plugins: [nodePolyfills({ include: ["buffer", "crypto", "util", "stream", "process", "events"], globals: { Buffer: true, process: true, global: true } })],
  },
});

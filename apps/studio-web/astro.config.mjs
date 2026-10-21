import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Static build (Cloudflare Pages: root apps/studio-web, build `bun install && bun run build`, output `dist`).
// Wallet SDKs still expect Node globals (Buffer, process, crypto) in the browser, hence the polyfills.
export default defineConfig({
  output: "static",
  integrations: [react()],
  vite: {
    plugins: [nodePolyfills({ include: ["buffer", "crypto", "util", "stream", "process", "events"], globals: { Buffer: true, process: true, global: true } })],
  },
});

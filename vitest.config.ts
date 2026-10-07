import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

// Outbound fetches from the test worker are served by the upstream-mock
// worker instead of the network, giving the proxy tests a deterministic
// range-serving origin with redirect, gating, and request-recording routes.
const upstreamMock = new URL(
  "./src/media/proxy/upstream-mock.js",
  import.meta.url
).pathname

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        outboundService: "upstream-mock",
        workers: [
          {
            name: "upstream-mock",
            compatibilityDate: "2026-10-01",
            modules: [{ type: "ESModule", path: upstreamMock }],
          },
        ],
      },
    }),
  ],
  test: {
    include: ["src/media/proxy/**/*.test.ts"],
  },
})

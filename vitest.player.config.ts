import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "happy-dom",
    environmentOptions: {
      happyDOM: { url: "http://localhost:3000" },
    },
    include: ["src/components/player/playback-stage.integration.test.tsx"],
  },
})

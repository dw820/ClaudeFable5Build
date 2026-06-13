import { defineConfig } from "vitest/config";
import { config } from "dotenv";

// Load .env so integration tests (gated by it.skipIf) can read API keys.
config();

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit tests cover the portable backend core (supabase/functions/_shared).
 *
 * The core is runtime-agnostic TypeScript: it uses no Deno APIs and no Node APIs,
 * so the exact same modules that run inside Supabase Edge Functions are exercised
 * here under Node with Vitest. Tests must not perform network calls, database
 * access or any other external side effect.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./supabase/functions/_shared", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: ["default"],
    testTimeout: 10_000,
    // Schema suites boot an in-process Postgres and apply every migration in `beforeAll`;
    // under full-suite parallelism (one worker per file) that can exceed the 10 s default.
    hookTimeout: 30_000,
    restoreMocks: true,
  },
});

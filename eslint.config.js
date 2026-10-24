// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";
import { defineConfig } from "eslint/config";

/**
 * Lint rules for the whole repository.
 *
 * `supabase/functions/<name>/index.ts` files are Deno entrypoints: they use Deno globals
 * and `npm:` specifiers, so they are linted with Deno globals and are intentionally not
 * part of the application tsconfig (type checking them is `npm run functions:check`,
 * which uses the real Deno toolchain).
 */
export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "supabase/functions/_shared/db/database.types.ts",
      "supabase/.temp/**",
      "integrations/google-apps-script/**",
      "Reset-web-para-programador/**",
      "client-handover/**",
      "public/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Files linted by type-aware rules but deliberately outside tsconfig.json.
          allowDefaultProject: ["eslint.config.js", "supabase/functions/*/index.ts"],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 16,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Project convention: `type` aliases everywhere, including object shapes. They
      // compose better with unions and inferred types, and keep the codebase uniform.
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "no-console": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
    },
  },

  {
    // Deno entrypoints run in the Supabase edge runtime, not in Node.
    //
    // These files are deliberately outside tsconfig.json, so the type-aware rules have no
    // type information for the Deno global and would report noise. The authoritative type
    // check for them is `npm run functions:check` (real Deno toolchain); the rules kept
    // here are the ones that still work without type information.
    files: ["supabase/functions/*/index.ts"],
    languageOptions: {
      globals: { Deno: "readonly", crypto: "readonly", console: "readonly", Response: "readonly" },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/dot-notation": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },

  {
    // Tests and tooling scripts may use Node globals and console output.
    files: [
      "tests/**/*.ts",
      "scripts/**/*.ts",
      "vitest.config.ts",
      "vite.config.ts",
      "eslint.config.js",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // Test doubles are often `async` without awaiting, and generic helpers exist
      // precisely to assert a caller-chosen type; both are intentional in tests.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

  prettier,
]);

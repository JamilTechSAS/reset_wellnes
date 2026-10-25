import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

import { resolve } from "node:path";

import { SITE_TARGET_ENV, includesPage, parseSiteTarget } from "./scripts/build-target.ts";

/**
 * Every page the site has.
 *
 * `demo-entradas.html` and `epayco-staging-smoke.html` are QA-only entries: the production artifact
 * must not contain either page, so the registry is filtered through `includesPage` before it becomes
 * the Rollup input. See `scripts/build-target.ts`.
 */
const PAGES = {
  main: "index.html",
  nosotros: "nosotros.html",
  entradas: "entradas.html",
  demoEntradas: "demo-entradas.html",
  epaycoSmoke: "epayco-staging-smoke.html",
  eventos: "eventos.html",
  marca: "marca-y-colaboracion.html",
  faq: "preguntas-frecuentes.html",
  terminos: "terminos-y-condiciones.html",
  gracias: "gracias.html",
} as const;

export default defineConfig(({ mode }) => {
  // `SITE_TARGET` is read from the environment or the env files, never from `import.meta.env`:
  // a build-time decision like this must not be shipped to the browser.
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const target = parseSiteTarget(process.env[SITE_TARGET_ENV] ?? fileEnv[SITE_TARGET_ENV]);
  const input = Object.fromEntries(
    Object.entries(PAGES)
      .filter(([, page]) => includesPage(target, page))
      .map(([name, page]): [string, string] => [name, resolve(__dirname, page)]),
  );

  return {
    resolve: {
      alias: {
        "@src": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 3000,
      open: false,
    },
    build: {
      target: "es2022",
      outDir: "dist",
      sourcemap: true,
      rollupOptions: {
        input,
      },
    },
  };
});

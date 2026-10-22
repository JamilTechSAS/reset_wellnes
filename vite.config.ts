import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

import { resolve } from "node:path";

export default defineConfig({
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
      input: {
        main: resolve(__dirname, "index.html"),
        nosotros: resolve(__dirname, "nosotros.html"),
        entradas: resolve(__dirname, "entradas.html"),
        eventos: resolve(__dirname, "eventos.html"),
        marca: resolve(__dirname, "marca-y-colaboracion.html"),
        faq: resolve(__dirname, "preguntas-frecuentes.html"),
        terminos: resolve(__dirname, "terminos-y-condiciones.html"),
      },
    },
  },
});

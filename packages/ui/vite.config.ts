import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const API_PORT = process.env.CONCORD_API_PORT ?? "3000";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src",
      "crypto-random-hex": fileURLToPath(new URL("./src/infra/shims/crypto-random-hex.cjs", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

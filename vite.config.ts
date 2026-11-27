import { defineConfig } from "vite";

// The collector serves the built client from dist/web. In development the Vite
// server proxies the API to a collector started with `npm run dev:server`.
export default defineConfig({
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    target: "es2023",
    // The LiveKit client (about 580 kB) is its own chunk, downloaded only when someone joins the conversation.
    chunkSizeWarningLimit: 650,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.DEV_COLLECTOR_URL ?? "http://127.0.0.1:8080",
    },
  },
});

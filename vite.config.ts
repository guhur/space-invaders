import { defineConfig } from "vite";

// En dev, `pnpm dev` sert le front et `wrangler dev` (port 8787) sert l'API.
export default defineConfig({
  server: { proxy: { "/api": "http://localhost:8787" } },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Vercel serves /assets/* with a one-year immutable cache, and Vite
    // content-hashes every filename, so this is safe.
    assetsDir: "assets",
    sourcemap: false,
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": new URL(".", import.meta.url).pathname,
      "server-only": new URL("./tests/helpers/server-only.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    // Database-backed suites create, migrate, close, and force-drop isolated databases in hooks.
    // Keep that bounded lifecycle aligned with the existing 30-second migration timeout.
    hookTimeout: 30_000,
    include: ["tests/unit/**/*.test.{ts,tsx}"],
  },
});

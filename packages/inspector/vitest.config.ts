import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  esbuild: { jsx: "automatic" },
  test: {
    include: ["test/**/*.test.ts", "client/src/**/*.test.{ts,tsx}"],
  },
});

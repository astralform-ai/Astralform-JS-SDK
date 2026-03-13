import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "react",
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});

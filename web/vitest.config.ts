import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["blueprint/**/*.test.ts"],
  },
});

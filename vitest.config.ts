import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(
        new URL("src/__tests__/vscode-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    // Only printed: the HTML and JSON reports would be files for tsc to check.
    coverage: {
      exclude: ["src/**/__tests__/**"],
      include: ["src/**/*.ts"],
      reporter: ["text"],
    },
    include: ["src/**/__tests__/*.test.ts"],
  },
});

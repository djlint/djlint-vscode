import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { vscode: fileURLToPath(new URL("src/__tests__/vscode-stub.ts", import.meta.url)) },
  },
  // Every test gets this bound; the suites that run a real djLint set a longer one.
  test: { include: ["src/**/__tests__/*.test.ts"], testTimeout: 5000 },
});

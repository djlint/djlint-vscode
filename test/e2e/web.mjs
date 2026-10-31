// Runs test/e2e/suite.cjs in VS Code for the Web, in a headless Chromium.
import path from "node:path";
import { runTests } from "@vscode/test-web";

const root = path.resolve(import.meta.dirname, "../..");

await runTests({
  browserType: "chromium",
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "test/e2e/suite.cjs"),
  folderPath: path.join(root, "test/e2e/fixture"),
  headless: true,
  quality: "stable",
});

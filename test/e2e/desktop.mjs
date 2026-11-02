// Runs test/e2e/suite.cjs in a downloaded VS Code, oldest supported and stable.
import { readFileSync } from "node:fs";
import path from "node:path";

import { runTests } from "@vscode/test-electron";

const root = path.resolve(import.meta.dirname, "../..");
const manifest =
  /** @type {{ engines: { vscode: string } }} */
  (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")));

for (const version of [manifest.engines.vscode.replace("^", ""), "stable"]) {
  console.log(`\nVS Code ${version}`);
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "test/e2e/suite.cjs"),
    launchArgs: [
      path.join(root, "test/e2e/fixture"),
      "--disable-extensions",
      "--disable-workspace-trust",
    ],
    version,
  });
}

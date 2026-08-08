import * as vscode from "vscode";
import { configSection } from "./config.js";
import { disposeEngine } from "./engine/select.js";
import { Formatter } from "./formatter.js";
import { Linter } from "./linter.js";
import {
  initializePythonEnvironment,
  onDidChangeActivePythonEnvironment,
} from "./python/environment.js";
import { invalidateDjlintCommandCache } from "./runner.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("djLint", {
    log: true,
  });

  const formatter = new Formatter(context, outputChannel);
  const linter = new Linter(context, outputChannel);

  // Rebuild the cached engine (lazily) whenever something that determines WHICH djLint runs changes, so it applies without a window reload. This also clears a FallbackEngine latched onto the bundled runtime.
  const engineSettings = ["executablePath", "pythonPath", "useVenv"];
  function invalidateResolution(): void {
    disposeEngine();
    // Also invalidates the cached djLint command: an independent module-level cache that would otherwise keep resolving to a stale command.
    invalidateDjlintCommandCache();
    // Diagnostics from the previous command/engine are now stale; re-lint open documents so they reflect the newly resolved djLint.
    void linter.refreshAll();
  }

  context.subscriptions.push(
    outputChannel,
    { dispose: disposeEngine },
    vscode.workspace.onDidGrantWorkspaceTrust(invalidateResolution),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        engineSettings.some((key) =>
          e.affectsConfiguration(`${configSection}.${key}`),
        )
      ) {
        invalidateResolution();
      }
    }),
    // The active interpreter can also change from outside VS Code's settings (via the Python extension's UI), hence its own listener.
    onDidChangeActivePythonEnvironment(invalidateResolution),
    // Manual escape hatch for an in-place djLint upgrade: the resolved command/version cache otherwise only refreshes after RESOLUTION_TTL_MS or one of the triggers above.
    vscode.commands.registerCommand("djlint.restart", invalidateResolution),
  );

  // Registers the disposal bridge for the eventual (lazy) activation of whichever Python extension is selected, and stashes outputChannel for it to log through; see src/python/environment.ts. Does NOT activate ms-python.vscode-python-envs or ms-python.python itself.
  initializePythonEnvironment(context.subscriptions, outputChannel);

  formatter.activate();
  context.subscriptions.push(formatter);

  await linter.activate();
  context.subscriptions.push(linter);
}

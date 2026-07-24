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

  // Rebuild the cached engine (lazily) whenever something that determines WHICH djLint runs changes, so it applies without a window reload — also clears a FallbackEngine latched onto the bundled runtime.
  const engineSettings = ["executablePath", "pythonPath", "useVenv"];
  // Also invalidates the cached djLint command: an independent module-level cache that would otherwise keep resolving to a stale command.
  function invalidateResolution(): void {
    disposeEngine();
    invalidateDjlintCommandCache();
  }

  context.subscriptions.push(
    outputChannel,
    { dispose: disposeEngine },
    vscode.workspace.onDidGrantWorkspaceTrust(disposeEngine),
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

  // Registers the disposal bridge for the Python extension's eventual (lazy) activation and stashes outputChannel for it to log through — see src/python/environment.ts. Does NOT activate ms-python.python itself.
  initializePythonEnvironment(context.subscriptions, outputChannel);

  const formatter = new Formatter(context, outputChannel);
  formatter.activate();
  context.subscriptions.push(formatter);

  const linter = new Linter(context, outputChannel);
  await linter.activate();
  context.subscriptions.push(linter);
}

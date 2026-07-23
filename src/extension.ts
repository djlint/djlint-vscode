import * as vscode from "vscode";
import { configSection } from "./config.js";
import { disposeEngine } from "./engine/select.js";
import { Formatter } from "./formatter.js";
import { Linter } from "./linter.js";
import { onDidChangeActivePythonEnvironment } from "./python/environment.js";
import { invalidateDjlintCommandCache } from "./runner.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("djLint", {
    log: true,
  });

  // Rebuild the cached engine (lazily) whenever something that determines WHICH djLint runs changes, so it applies without a window reload — this also clears a FallbackEngine that latched onto the bundled runtime, letting a newly installed djLint take over.
  const engineSettings = [
    "executablePath",
    "importStrategy",
    "interpreter",
    "path",
    "useVenv",
  ];
  // Also invalidates the cached djLint command (src/runner.ts) alongside the cached engine: they're independent module-level caches, so a fresh engine created after disposeEngine() would otherwise keep resolving to a stale command.
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
    // The active interpreter can also change from outside VS Code's settings (switching environments via the Python extension's UI), so this needs its own listener rather than folding into the config-change one above.
    onDidChangeActivePythonEnvironment(invalidateResolution),
  );

  const formatter = new Formatter(context, outputChannel);
  formatter.activate();
  context.subscriptions.push(formatter);

  const linter = new Linter(context, outputChannel);
  await linter.activate();
  context.subscriptions.push(linter);
}

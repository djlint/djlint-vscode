import * as vscode from "vscode";
import { startExtension } from "./activate.js";
import { createDesktopEngine } from "./engine/desktop.js";
import { EngineManager } from "./engine/select.js";
import { PythonEnvironments } from "./python/environment.js";
import { DjlintStatus } from "./status.js";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("djLint", {
    log: true,
  });
  const status = new DjlintStatus();
  const pythonEnvironments = new PythonEnvironments(outputChannel);
  const engines = new EngineManager(() =>
    createDesktopEngine(
      context.extensionUri,
      outputChannel,
      pythonEnvironments,
      status,
    ),
  );

  const refresh = startExtension(
    context,
    outputChannel,
    status,
    engines,
    () => {
      pythonEnvironments.resetIfUnavailable();
    },
  );

  context.subscriptions.push(
    pythonEnvironments,
    // SubprocessEngine forgets what it found. Nothing else depends on the environment, least of all a running Pyodide.
    pythonEnvironments.onDidChange(refresh),
  );
}

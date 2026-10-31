import * as vscode from "vscode";
import { configSection } from "./config.js";
import { EngineManager, engineSettingKeys } from "./engine/select.js";
import { Formatter } from "./formatter.js";
import { Linter } from "./linter.js";
import { PythonEnvironments } from "./python/environment.js";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("djLint", {
    log: true,
  });

  const pythonEnvironments = new PythonEnvironments(outputChannel);
  const engines = new EngineManager(
    context.extensionUri,
    outputChannel,
    pythonEnvironments,
  );
  const formatter = new Formatter(context, engines);
  const linter = new Linter(context, outputChannel, engines);

  function restart(): void {
    engines.reset();
    pythonEnvironments.resetIfUnavailable();
    void linter.refreshAll();
  }

  context.subscriptions.push(
    outputChannel,
    engines,
    pythonEnvironments,
    vscode.workspace.onDidGrantWorkspaceTrust(restart),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        engineSettingKeys.some((key) =>
          e.affectsConfiguration(`${configSection}.${key}`),
        )
      ) {
        restart();
      }
    }),
    pythonEnvironments.onDidChange(restart),
    vscode.commands.registerCommand("djlint.restart", restart),
    formatter,
    linter,
  );

  formatter.activate();
  linter.activate();
}

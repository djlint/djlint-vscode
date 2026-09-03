import * as vscode from "vscode";
import { configSection } from "./config.js";
import { disposeEngine } from "./engine/select.js";
import { Formatter } from "./formatter.js";
import { Linter } from "./linter.js";
import {
  initializePythonEnvironment,
  onDidChangeActivePythonEnvironment,
} from "./python/environment.js";
import {
  invalidateDjlintCommandCache,
  resolutionSettingKeys,
} from "./runner.js";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("djLint", {
    log: true,
  });

  const formatter = new Formatter(context, outputChannel);
  const linter = new Linter(context, outputChannel);

  function invalidateResolution(): void {
    disposeEngine();
    invalidateDjlintCommandCache();
    void linter.refreshAll();
  }

  context.subscriptions.push(
    outputChannel,
    { dispose: disposeEngine },
    vscode.workspace.onDidGrantWorkspaceTrust(invalidateResolution),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(configSection) &&
        resolutionSettingKeys.some((key) =>
          e.affectsConfiguration(`${configSection}.${key}`),
        )
      ) {
        invalidateResolution();
      }
    }),
    onDidChangeActivePythonEnvironment(invalidateResolution),
    vscode.commands.registerCommand("djlint.restart", invalidateResolution),
    formatter,
    linter,
  );

  initializePythonEnvironment(context.subscriptions, outputChannel);

  formatter.activate();
  linter.activate();
}

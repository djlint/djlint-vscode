import * as vscode from "vscode";

import { configSection } from "./config.js";
import { engineSettingKeys } from "./engine/select.js";
import type { EngineManager } from "./engine/select.js";
import { Formatter } from "./formatter.js";
import { Linter } from "./linter.js";
import type { DjlintStatus } from "./status.js";

export function startExtension(
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
  status: DjlintStatus,
  engines: EngineManager,
  beforeRestart?: () => void,
): () => void {
  const formatter = new Formatter(context, engines);
  const linter = new Linter(context, outputChannel, engines);

  function refresh(): void {
    status.clear();
    void linter.refreshAll();
  }

  function restart(): void {
    engines.reset();
    beforeRestart?.();
    refresh();
  }

  context.subscriptions.push(
    outputChannel,
    status,
    engines,
    vscode.workspace.onDidGrantWorkspaceTrust(restart),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${configSection}.formatLanguages`)) {
        status.refreshLanguages();
      }
      if (engineSettingKeys.some((key) => e.affectsConfiguration(`${configSection}.${key}`))) {
        restart();
      }
    }),
    vscode.commands.registerCommand("djlint.restart", restart),
    vscode.commands.registerCommand("djlint.showLogs", () => {
      outputChannel.show();
    }),
    formatter,
    linter,
  );

  formatter.activate();
  linter.activate();
  return refresh;
}

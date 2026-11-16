import * as vscode from "vscode";

import { configSection } from "./config.js";
import { engineSettingKeys } from "./engine/select.js";
import type { EngineManager } from "./engine/select.js";
import { Formatter } from "./formatter.js";
import { Linter } from "./linter.js";
import { forgetShownWarnings } from "./notify.js";
import { EXTENSION_ID, updateForLanguage } from "./status.js";
import type { DjlintStatus } from "./status.js";

async function toggleForActiveLanguage(key: string): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (document) {
    const value = vscode.workspace.getConfiguration(configSection, document).get<boolean>(key);
    await updateForLanguage(document, configSection, key, !value);
  }
}

export function startExtension(
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
  status: DjlintStatus,
  engines: EngineManager,
  beforeRestart?: () => void,
): () => void {
  const formatter = new Formatter(context, engines, status);
  const linter = new Linter(context, outputChannel, engines, status);

  function refresh(): void {
    status.clear();
    void linter.refreshAll();
  }

  function restart(): void {
    forgetShownWarnings();
    engines.reset();
    beforeRestart?.();
    refresh();
  }

  // The files djLint reads its settings and rules from, wherever it finds them in the workspace.
  const configFiles = vscode.workspace.createFileSystemWatcher(
    "**/{pyproject.toml,djlint.toml,.djlint.toml,.djlintrc,.djlint_rules.yaml}",
  );

  context.subscriptions.push(
    outputChannel,
    configFiles,
    configFiles.onDidChange(forgetShownWarnings),
    configFiles.onDidCreate(forgetShownWarnings),
    configFiles.onDidDelete(forgetShownWarnings),
    status,
    engines,
    vscode.workspace.onDidGrantWorkspaceTrust(restart),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(configSection)) {
        forgetShownWarnings();
      }
      if (engineSettingKeys.some((key) => e.affectsConfiguration(`${configSection}.${key}`))) {
        restart();
      }
    }),
    vscode.commands.registerCommand("djlint.restart", restart),
    vscode.commands.registerCommand("djlint.showLogs", () => {
      outputChannel.show();
    }),
    vscode.commands.registerCommand("djlint.showMenu", async () => status.showMenu()),
    vscode.commands.registerCommand("djlint.openSettings", async () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID}`),
    ),
    vscode.commands.registerCommand("djlint.toggleLinting", async () =>
      toggleForActiveLanguage("enableLinting"),
    ),
    vscode.commands.registerCommand("djlint.toggleLintOnType", async () =>
      toggleForActiveLanguage("lintOnType"),
    ),
    vscode.commands.registerCommand("djlint.useAsFormatter", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document) {
        await updateForLanguage(document, "editor", "defaultFormatter", EXTENSION_ID);
      }
    }),
    formatter,
    linter,
  );

  formatter.activate();
  linter.activate();
  return refresh;
}

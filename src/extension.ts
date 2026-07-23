import * as vscode from "vscode";
import { configSection } from "./config.js";
import { disposeEngine } from "./engine/select.js";
import { Formatter } from "./formatter.js";
import { Linter } from "./linter.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("djLint", {
    log: true,
  });

  // Rebuild the cached engine (on next use) when workspace trust or importStrategy changes, so the choice applies without a window reload.
  context.subscriptions.push(
    outputChannel,
    { dispose: disposeEngine },
    vscode.workspace.onDidGrantWorkspaceTrust(disposeEngine),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${configSection}.importStrategy`)) {
        disposeEngine();
      }
    }),
  );

  const formatter = new Formatter(context, outputChannel);
  formatter.activate();
  context.subscriptions.push(formatter);

  const linter = new Linter(context, outputChannel);
  await linter.activate();
  context.subscriptions.push(linter);
}

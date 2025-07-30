import * as vscode from "vscode";
import { Formatter } from "./formatter.js";
import { Linter } from "./linter.js";
import { disposeIsolatedRunner } from "./runner.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("djLint", {
    log: true,
  });
  context.subscriptions.push(outputChannel);
  new Formatter(context, outputChannel).activate();
  await new Linter(context, outputChannel).activate();
}

export function deactivate(): void {
  disposeIsolatedRunner();
}

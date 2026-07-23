import * as vscode from "vscode";
import { disposeEngine } from "./engine/select.js";
import { Formatter } from "./formatter.js";
import { Linter } from "./linter.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("djLint", {
    log: true,
  });
  context.subscriptions.push(outputChannel, { dispose: disposeEngine });

  const formatter = new Formatter(context, outputChannel);
  formatter.activate();
  context.subscriptions.push(formatter);

  const linter = new Linter(context, outputChannel);
  await linter.activate();
  context.subscriptions.push(linter);
}

import type vscode from "vscode";
import { Formatter } from "./formatter";
import { Linter } from "./linter";

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  new Formatter(context).activate();
  await new Linter(context).activate();
}

import vscode from "vscode";
import { formattingArgs } from "./args";
import { runDjlint } from "./runner";
import { getConfig } from "./utils";

export class Formatter implements vscode.DocumentFormattingEditProvider {
  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions
  ): Promise<vscode.TextEdit[]> {
    const config = getConfig();

    let stdout;
    try {
      stdout = await runDjlint(config, document, formattingArgs, options);
    } catch {
      return [];
    }
    if (!stdout.trim()) {
      return [];
    }

    const lastLineId = document.lineCount - 1;
    const lastLineLength = document.lineAt(lastLineId).text.length;
    const range = new vscode.Range(0, 0, lastLineId, lastLineLength);
    return [vscode.TextEdit.replace(range, stdout)];
  }
}

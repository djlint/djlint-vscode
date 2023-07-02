import vscode from "vscode";
import { formattingArgs } from "./args";
import { configSection, getConfig } from "./config";
import { runDjlint } from "./runner";

export class Formatter implements vscode.DocumentFormattingEditProvider {
  protected providerDisposable: vscode.Disposable | undefined;

  constructor(protected readonly context: vscode.ExtensionContext) {}

  activate(): void {
    this.register();

    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${configSection}.formatLanguages`)) {
          this.register();
        }
      })
    );
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions
  ): Promise<vscode.TextEdit[]> {
    const config = getConfig(document);

    let stdout;
    try {
      stdout = await runDjlint(document, config, formattingArgs, options);
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

  protected register(): void {
    const languages = getConfig().get<string[]>("formatLanguages");
    this.providerDisposable?.dispose();
    if (languages != null) {
      this.providerDisposable =
        vscode.languages.registerDocumentFormattingEditProvider(
          languages,
          this
        );
      this.context.subscriptions.push(this.providerDisposable);
    }
  }
}

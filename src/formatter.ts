import vscode from "vscode";
import { formattingArgs } from "./args";
import { configSection, getConfig } from "./config";
import { runDjlint } from "./runner";

export class Formatter implements vscode.DocumentFormattingEditProvider {
  readonly #context: vscode.ExtensionContext;
  readonly #outputChannel: vscode.LogOutputChannel;
  #providerDisposable: vscode.Disposable | undefined;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.LogOutputChannel,
  ) {
    this.#context = context;
    this.#outputChannel = outputChannel;
  }

  activate(): void {
    this.#register();

    this.#context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${configSection}.formatLanguages`)) {
          this.#register();
        }
      }),
    );
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
  ): Promise<vscode.TextEdit[] | undefined> {
    const config = getConfig(document);

    let stdout;
    try {
      stdout = await runDjlint(
        document,
        config,
        formattingArgs,
        this.#outputChannel,
        options,
      );
    } catch {
      return void 0;
    }

    const lastLineId = document.lineCount - 1;
    const lastLineLength = document.lineAt(lastLineId).text.length;
    const range = new vscode.Range(0, 0, lastLineId, lastLineLength);
    return [vscode.TextEdit.replace(range, stdout)];
  }

  #register(): void {
    const languages = getConfig().get<readonly string[]>("formatLanguages");
    this.#providerDisposable?.dispose();
    if (languages != null) {
      this.#providerDisposable =
        vscode.languages.registerDocumentFormattingEditProvider(
          languages,
          this,
        );
      this.#context.subscriptions.push(this.#providerDisposable);
    }
  }
}

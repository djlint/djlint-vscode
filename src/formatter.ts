import * as vscode from "vscode";
import { configSection, getConfig } from "./config.js";
import { getEngine } from "./engine/select.js";

export class Formatter implements vscode.DocumentFormattingEditProvider {
  readonly #context: vscode.ExtensionContext;
  readonly #outputChannel: vscode.LogOutputChannel;
  readonly #running: Map<string, vscode.CancellationTokenSource>;
  #providerDisposable: vscode.Disposable | undefined;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.LogOutputChannel,
  ) {
    this.#context = context;
    this.#outputChannel = outputChannel;
    this.#running = new Map();
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

  dispose(): void {
    this.#providerDisposable?.dispose();
    this.#providerDisposable = void 0;
    for (const source of this.#running.values()) {
      source.cancel();
      source.dispose();
    }
    this.#running.clear();
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[] | undefined> {
    const config = getConfig(document);

    const key = document.uri.toString();
    this.#running.get(key)?.cancel();
    const source = new vscode.CancellationTokenSource();
    this.#running.set(key, source);
    token.onCancellationRequested(() => {
      source.cancel();
    });

    let stdout: string;
    try {
      stdout = await getEngine(this.#outputChannel).format(
        document,
        config,
        options,
        source.token,
      );
    } catch {
      return void 0;
    } finally {
      source.dispose();
      if (this.#running.get(key) === source) {
        this.#running.delete(key);
      }
    }

    const lastLineId = document.lineCount - 1;
    const lastLineLength = document.lineAt(lastLineId).text.length;
    const range = new vscode.Range(0, 0, lastLineId, lastLineLength);
    return [vscode.TextEdit.replace(range, stdout)];
  }

  #register(): void {
    const languages = getConfig().get<readonly string[]>("formatLanguages");
    this.#providerDisposable?.dispose();
    this.#providerDisposable = languages?.length
      ? vscode.languages.registerDocumentFormattingEditProvider(languages, this)
      : void 0;
  }
}

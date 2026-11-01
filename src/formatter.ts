import * as vscode from "vscode";
import { CancellationRegistry } from "./cancellation-registry.js";
import { configSection, getConfig } from "./config.js";
import type { EngineManager } from "./engine/select.js";

export class Formatter implements vscode.DocumentFormattingEditProvider {
  readonly #context: vscode.ExtensionContext;
  readonly #engines: EngineManager;
  readonly #registry: CancellationRegistry;
  #providerDisposable: vscode.Disposable | undefined;

  constructor(context: vscode.ExtensionContext, engines: EngineManager) {
    this.#context = context;
    this.#engines = engines;
    this.#registry = new CancellationRegistry();
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
    this.#registry.disposeAll();
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[] | undefined> {
    const config = getConfig(document);

    const key = document.uri.toString();
    const source = this.#registry.start(key);
    const cancellation = token.onCancellationRequested(() => {
      source.cancel();
    });

    let stdout: string;
    try {
      stdout = await this.#engines.engine.format(document, config, options, source.token);
    } catch {
      return void 0;
    } finally {
      cancellation.dispose();
      this.#registry.finish(key, source);
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

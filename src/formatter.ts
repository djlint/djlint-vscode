import * as vscode from "vscode";
import { formattingArgs } from "./args.js";
import { configSection, getConfig } from "./config.js";
import { runDjlint } from "./runner.js";

export class Formatter implements vscode.DocumentFormattingEditProvider {
  readonly #context: vscode.ExtensionContext;
  readonly #outputChannel: vscode.LogOutputChannel;
  readonly #runningControllers: Map<string, AbortController>;
  #providerDisposable: vscode.Disposable | undefined;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.LogOutputChannel,
  ) {
    this.#context = context;
    this.#outputChannel = outputChannel;
    this.#runningControllers = new Map();
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
    for (const controller of this.#runningControllers.values()) {
      controller.abort();
    }
    this.#runningControllers.clear();
  }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[] | undefined> {
    const config = getConfig(document);

    const key = document.uri.toString();
    this.#runningControllers.get(key)?.abort();
    const controller = new AbortController();
    this.#runningControllers.set(key, controller);
    token.onCancellationRequested(() => controller.abort());

    let stdout: string;
    try {
      stdout = await runDjlint(
        document,
        config,
        formattingArgs,
        this.#outputChannel,
        controller,
        options,
      );
    } catch {
      return void 0;
    } finally {
      this.#runningControllers.delete(key);
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

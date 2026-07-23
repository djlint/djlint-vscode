import * as vscode from "vscode";
import { getConfig } from "./config.js";
import { getEngine } from "./engine/select.js";

const supportedUriSchemes: ReadonlySet<string> = new Set([
  "file",
  "vscode-vfs",
]);

export class Linter {
  readonly #collection: vscode.DiagnosticCollection;
  readonly #context: vscode.ExtensionContext;
  readonly #outputChannel: vscode.LogOutputChannel;
  readonly #running: Map<string, vscode.CancellationTokenSource>;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.LogOutputChannel,
  ) {
    this.#collection = vscode.languages.createDiagnosticCollection("djLint");
    context.subscriptions.push(this.#collection);
    this.#context = context;
    this.#outputChannel = outputChannel;
    this.#running = new Map();
  }

  async activate(): Promise<void> {
    const maybeLint = async (document: vscode.TextDocument): Promise<void> => {
      try {
        await this.#lint(document);
      } catch {}
    };

    this.#context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(maybeLint),
      vscode.workspace.onDidSaveTextDocument(maybeLint),
      vscode.workspace.onDidCloseTextDocument(({ uri }) => {
        this.#collection.delete(uri);
        const key = uri.toString();
        const source = this.#running.get(key);
        source?.cancel();
        source?.dispose();
        this.#running.delete(key);
      }),
    );

    try {
      for (const document of vscode.workspace.textDocuments) {
        if (!this.#collection.has(document.uri)) {
          // eslint-disable-next-line no-await-in-loop
          await this.#lint(document);
        }
      }
    } catch {}
  }

  dispose(): void {
    for (const source of this.#running.values()) {
      source.cancel();
      source.dispose();
    }
    this.#running.clear();
  }

  async #lint(document: vscode.TextDocument): Promise<void> {
    const config = getConfig(document);

    if (!config.get<boolean>("enableLinting")) {
      this.#collection.delete(document.uri);
      return;
    }

    if (!supportedUriSchemes.has(document.uri.scheme)) {
      this.#outputChannel.debug(
        `Not linting "${document.uri.toString()}" (unsupported scheme)`,
      );
      return;
    }

    const key = document.uri.toString();
    this.#running.get(key)?.cancel();
    const source = new vscode.CancellationTokenSource();
    this.#running.set(key, source);

    let diagnostics;
    try {
      diagnostics = await getEngine(this.#context, this.#outputChannel).lint(
        document,
        config,
        source.token,
      );
    } catch (e) {
      this.#collection.delete(document.uri);
      if (source.token.isCancellationRequested) {
        return;
      }
      throw e;
    } finally {
      source.dispose();
      if (this.#running.get(key) === source) {
        this.#running.delete(key);
      }
    }

    this.#collection.set(
      document.uri,
      diagnostics.map((d) => {
        const range = new vscode.Range(
          d.line - 1,
          d.column,
          d.line - 1,
          d.column,
        );
        return new vscode.Diagnostic(range, `${d.message} (${d.code})`);
      }),
    );
  }
}

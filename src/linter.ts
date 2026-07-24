import * as vscode from "vscode";
import { CancellationRegistry } from "./cancellation-registry.js";
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
  readonly #registry: CancellationRegistry;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.LogOutputChannel,
  ) {
    this.#collection = vscode.languages.createDiagnosticCollection("djLint");
    context.subscriptions.push(this.#collection);
    this.#context = context;
    this.#outputChannel = outputChannel;
    this.#registry = new CancellationRegistry();
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
        this.#registry.cancelAndDelete(uri.toString());
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
    this.#registry.disposeAll();
  }

  async #lint(document: vscode.TextDocument): Promise<void> {
    const config = getConfig(document);

    if (!config.get<boolean>("enableLinting")) {
      this.#collection.delete(document.uri);
      return;
    }

    // `enableLinting` alone doesn't scope by language (it can legitimately be set globally); gating on `formatLanguages` (the list of languages djLint handles) is what keeps a global `enableLinting: true` from linting every file in the workspace.
    if (
      !config
        .get<readonly string[]>("formatLanguages")
        ?.includes(document.languageId)
    ) {
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
    const source = this.#registry.start(key);

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
      this.#registry.finish(key, source);
    }

    // A newer run for this document may have superseded us while awaiting.
    if (this.#registry.has(key) || source.token.isCancellationRequested) {
      return;
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
        const diagnostic = new vscode.Diagnostic(
          range,
          d.message,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = "djLint";
        diagnostic.code = {
          target: vscode.Uri.parse(
            `https://djlint.com/docs/linter/#${d.code.toLowerCase()}`,
          ),
          value: d.code,
        };
        return diagnostic;
      }),
    );
  }
}

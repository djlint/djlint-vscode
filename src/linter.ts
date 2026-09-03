import * as vscode from "vscode";
import { lintingArgs } from "./args.js";
import { CancellationRegistry } from "./cancellation-registry.js";
import { configSection, getConfig } from "./config.js";
import { getEngine } from "./engine/select.js";
import type { LintDiagnostic } from "./engine/types.js";
import { supportedUriSchemes } from "./schemes.js";

const lintSettingKeys: readonly string[] = [
  "enableLinting",
  ...lintingArgs.map((arg) => arg.vscodeName).filter(Boolean),
];

function visibleFirst(
  documents: readonly vscode.TextDocument[],
): readonly vscode.TextDocument[] {
  const visible = new Set(
    vscode.window.visibleTextEditors.map((editor) => editor.document),
  );
  if (visible.size === 0) {
    return documents;
  }
  return documents.toSorted(
    (a, b) => Number(visible.has(b)) - Number(visible.has(a)),
  );
}

function toDiagnostic(d: LintDiagnostic): vscode.Diagnostic {
  const editorLine = d.line - 1;
  const range = new vscode.Range(editorLine, d.column, editorLine, d.column);
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
}

export class Linter {
  readonly #collection: vscode.DiagnosticCollection;
  readonly #context: vscode.ExtensionContext;
  readonly #outputChannel: vscode.LogOutputChannel;
  readonly #registry: CancellationRegistry;
  #disposed = false;

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

  activate(): void {
    this.#context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        void this.#safeLint(document);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.#safeLint(document);
      }),
      vscode.workspace.onDidCloseTextDocument(({ uri }) => {
        this.#collection.delete(uri);
        this.#registry.cancelAndDelete(uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        void this.#onConfigChange(e);
      }),
    );

    void this.#lintUndiagnosedDocuments();
  }

  async refreshAll(): Promise<void> {
    await this.#lintSweep(() => true);
  }

  dispose(): void {
    this.#disposed = true;
    this.#registry.disposeAll();
  }

  async #lintSweep(
    shouldLint: (document: vscode.TextDocument) => boolean,
  ): Promise<void> {
    for (const document of visibleFirst(vscode.workspace.textDocuments)) {
      if (this.#disposed) {
        return;
      }
      if (shouldLint(document)) {
        // eslint-disable-next-line no-await-in-loop -- sequential, so a window full of templates never fans out into one djLint run per editor
        await this.#safeLint(document);
      }
    }
  }

  async #lintUndiagnosedDocuments(): Promise<void> {
    await this.#lintSweep((document) => !this.#collection.has(document.uri));
  }

  async #safeLint(document: vscode.TextDocument): Promise<void> {
    try {
      await this.#lint(document);
    } catch {}
  }

  async #onConfigChange(e: vscode.ConfigurationChangeEvent): Promise<void> {
    if (
      !e.affectsConfiguration(configSection) ||
      lintSettingKeys.every(
        (key) => !e.affectsConfiguration(`${configSection}.${key}`),
      )
    ) {
      return;
    }
    await this.#lintSweep((document) =>
      lintSettingKeys.some((key) =>
        e.affectsConfiguration(`${configSection}.${key}`, document),
      ),
    );
  }

  async #lint(document: vscode.TextDocument): Promise<void> {
    if (this.#disposed) {
      return;
    }

    const config = getConfig(document);

    if (!config.get<boolean>("enableLinting")) {
      this.#registry.cancelAndDelete(document.uri.toString());
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
      const wasSuperseded = source.token.isCancellationRequested;
      if (!wasSuperseded) {
        this.#collection.delete(document.uri);
      }
      throw e;
    } finally {
      this.#registry.finish(key, source);
    }

    const wasSuperseded =
      this.#registry.has(key) || source.token.isCancellationRequested;
    if (!wasSuperseded) {
      this.#collection.set(
        document.uri,
        diagnostics.map((d) => toDiagnostic(d)),
      );
    }
  }
}

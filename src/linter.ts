import * as vscode from "vscode";
import { lintingArgs } from "./args.js";
import { CancellationRegistry } from "./cancellation-registry.js";
import { configSection, getConfig } from "./config.js";
import { getEngine } from "./engine/select.js";

const supportedUriSchemes: ReadonlySet<string> = new Set([
  "file",
  "vscode-vfs",
]);

/** Settings whose value changes djLint's lint output, so open documents must
be re-linted when they change. Derived from lintingArgs (plus enableLinting,
which gates linting itself) so a newly added linting option is covered
automatically, with no second list to keep in sync. */
const lintSettingKeys: readonly string[] = [
  "enableLinting",
  ...lintingArgs.map((arg) => arg.vscodeName).filter(Boolean),
];

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

  async activate(): Promise<void> {
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
      // Keep diagnostics in sync when a lint-affecting setting changes, e.g. clearing a language's warnings once linting is disabled for it, not just on save.
      vscode.workspace.onDidChangeConfiguration((e) => {
        void this.#onConfigChange(e);
      }),
    );

    for (const document of vscode.workspace.textDocuments) {
      if (this.#disposed) {
        return;
      }
      if (!this.#collection.has(document.uri)) {
        // eslint-disable-next-line no-await-in-loop
        await this.#safeLint(document);
      }
    }
  }

  /** Re-lints every open document, e.g. after the resolved djLint command
  changes (interpreter, executablePath/pythonPath/useVenv, workspace trust, or
  the djLint: Restart command), so diagnostics reflect the new command instead
  of staying stale until the next save. */
  async refreshAll(): Promise<void> {
    for (const document of vscode.workspace.textDocuments) {
      if (this.#disposed) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.#safeLint(document);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#registry.disposeAll();
  }

  /** `#lint` wrapped to swallow errors: linting is best-effort (the engine may
  be unavailable, or a run cancelled) and must never surface as an unhandled
  rejection from an event handler. */
  async #safeLint(document: vscode.TextDocument): Promise<void> {
    try {
      await this.#lint(document);
    } catch {}
  }

  /** Re-lints (or clears, when now disabled) each open document whose
  lint-affecting configuration changed for its scope, so toggling
  enableLinting, switching profile, or editing configuration/rules updates
  diagnostics immediately. */
  async #onConfigChange(e: vscode.ConfigurationChangeEvent): Promise<void> {
    for (const document of vscode.workspace.textDocuments) {
      if (this.#disposed) {
        return;
      }
      const isAffected = lintSettingKeys.some((key) =>
        e.affectsConfiguration(`${configSection}.${key}`, document),
      );
      if (isAffected) {
        // eslint-disable-next-line no-await-in-loop
        await this.#safeLint(document);
      }
    }
  }

  async #lint(document: vscode.TextDocument): Promise<void> {
    // Stop once disposed: a detached refreshAll()/#onConfigChange loop must not start new engine work (which would rebuild the just-disposed engine) after teardown.
    if (this.#disposed) {
      return;
    }

    const config = getConfig(document);

    if (!config.get<boolean>("enableLinting")) {
      // Cancel any in-flight run too, or it could finish later and republish the diagnostics we're about to delete.
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
      // A superseded run always has its token cancelled (registry.start cancels the prior one), so bail BEFORE deleting: otherwise this run wipes the diagnostics the newer run already published. Only a genuine (non-cancelled) failure should clear them.
      if (source.token.isCancellationRequested) {
        return;
      }
      this.#collection.delete(document.uri);
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

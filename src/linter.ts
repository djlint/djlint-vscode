import * as vscode from "vscode";
import { lintingArgs } from "./args.js";
import { CancellationRegistry } from "./cancellation-registry.js";
import { configSection, getConfig } from "./config.js";
import type { EngineManager } from "./engine/select.js";
import type { LintDiagnostic } from "./engine/types.js";
import { isSupportedDocument } from "./paths.js";

const lintOnTypeDelayMs = 300;
const lintOnTypeMaxDelayMs = 1000;

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
  return visible.size === 0
    ? documents
    : documents.toSorted(
        (a, b) => Number(visible.has(b)) - Number(visible.has(a)),
      );
}

// The editor counts UTF-16 code units and djLint characters, which differ past an emoji.
function toEditorColumn(text: string, column: number): number {
  let offset = 0;
  for (let index = 0; index < column; index += 1) {
    offset += (text.codePointAt(offset) ?? 0) > 0xff_ff ? 2 : 1;
  }
  return offset;
}

function toRange(
  d: LintDiagnostic,
  document: vscode.TextDocument,
): vscode.Range {
  const line = d.line - 1;
  const { text } =
    line < document.lineCount ? document.lineAt(line) : { text: "" };
  function toColumn(column: number): number {
    return d.isUtf16 ? column : toEditorColumn(text, column);
  }
  const start = toColumn(d.column);
  if (d.endLine == null || d.endColumn == null) {
    return new vscode.Range(line, start, line, start);
  }
  // A finding over several lines is underlined on its first: a block in red says less than its tag.
  const end = d.endLine === d.line ? toColumn(d.endColumn) : text.length;
  return new vscode.Range(line, start, line, Math.max(start, end));
}

function toDiagnostic(
  d: LintDiagnostic,
  document: vscode.TextDocument,
): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(toRange(d, document), d.message);
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
  readonly #engines: EngineManager;
  readonly #outputChannel: vscode.LogOutputChannel;
  readonly #registry: CancellationRegistry;
  readonly #typingTimers = new Map<string, NodeJS.Timeout>();
  #disposed = false;
  #lastLintMs = 0;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.LogOutputChannel,
    engines: EngineManager,
  ) {
    this.#collection = vscode.languages.createDiagnosticCollection("djLint");
    context.subscriptions.push(this.#collection);
    this.#context = context;
    this.#engines = engines;
    this.#outputChannel = outputChannel;
    this.#registry = new CancellationRegistry();
  }

  activate(): void {
    this.#context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        void this.#safeLint(document);
      }),
      vscode.workspace.onDidChangeTextDocument(
        ({ contentChanges, document }) => {
          if (contentChanges.length > 0) {
            this.#lintAfterTyping(document);
          }
        },
      ),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.#stopTypingTimer(document.uri.toString());
        void this.#safeLint(document);
      }),
      vscode.workspace.onDidCloseTextDocument(({ uri }) => {
        this.#stopTypingTimer(uri.toString());
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
    for (const key of this.#typingTimers.keys()) {
      this.#stopTypingTimer(key);
    }
    this.#registry.disposeAll();
  }

  #lintAfterTyping(document: vscode.TextDocument): void {
    const config = getConfig(document);
    if (
      !config.get<boolean>("enableLinting") ||
      !config.get<boolean>("lintOnType") ||
      !isSupportedDocument(document)
    ) {
      return;
    }
    const key = document.uri.toString();
    this.#stopTypingTimer(key);
    // A pause shorter than a run would start one after another while typing, as the command line takes half a second.
    // A first run can also include starting djLint or a stalled lookup of the environment, which mustn't hold up the next for long.
    const delay = Math.min(
      Math.max(lintOnTypeDelayMs, this.#lastLintMs),
      lintOnTypeMaxDelayMs,
    );
    this.#typingTimers.set(
      key,
      setTimeout(() => {
        this.#typingTimers.delete(key);
        void this.#safeLint(document);
      }, delay),
    );
  }

  #stopTypingTimer(key: string): void {
    clearTimeout(this.#typingTimers.get(key));
    this.#typingTimers.delete(key);
  }

  async #lintSweep(
    shouldLint: (document: vscode.TextDocument) => boolean,
  ): Promise<void> {
    for (const document of visibleFirst(vscode.workspace.textDocuments)) {
      if (this.#disposed) {
        return;
      }
      if (shouldLint(document)) {
        // oxlint-disable-next-line no-await-in-loop -- sequential, so a window full of templates never fans out into one djLint run per editor
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
    if (this.#disposed || document.isClosed) {
      return;
    }

    const config = getConfig(document);

    if (!config.get<boolean>("enableLinting")) {
      this.#registry.cancelAndDelete(document.uri.toString());
      this.#collection.delete(document.uri);
      return;
    }

    if (!isSupportedDocument(document)) {
      this.#outputChannel.debug(
        `Not linting "${document.uri.toString()}" (unsupported scheme)`,
      );
      return;
    }

    const key = document.uri.toString();
    const source = this.#registry.start(key);
    const versionAtStart = document.version;
    const startedAt = performance.now();

    let diagnostics;
    try {
      diagnostics = await this.#engines.engine.lint(
        document,
        config,
        source.token,
      );
      this.#lastLintMs = performance.now() - startedAt;
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
    if (wasSuperseded) {
      return;
    }
    // The positions are of a text the document no longer has.
    if (document.version !== versionAtStart) {
      if (!this.#typingTimers.has(key)) {
        void this.#safeLint(document);
      }
      return;
    }
    this.#collection.set(
      document.uri,
      diagnostics.map((d) => toDiagnostic(d, document)),
    );
  }
}

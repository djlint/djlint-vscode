import * as vscode from "vscode";
import { PyodideEngine } from "./pyodide/index.js";
import { SubprocessEngine } from "./subprocess/index.js";
import {
  DjlintUnavailableError,
  type DjlintEngine,
  type LintDiagnostic,
} from "./types.js";

export interface EngineSelectionDeps<T> {
  isTrusted: boolean;
  makeSubprocess: () => T;
  makePyodide: () => T;
}

/** Pure decision: which engine to build, given workspace-trust state. No
VS Code dependency, so it is unit-testable in isolation.

- A trusted desktop host tries the environment djLint (`makeSubprocess`
  always wraps it so it transparently falls back to the bundled runtime when
  djLint is unavailable — see `FallbackEngine`).
- An untrusted workspace ALWAYS gets the sandboxed bundled runtime: we never
  execute an environment tool on untrusted content. */
export function selectEngine<T>(deps: EngineSelectionDeps<T>): T {
  return deps.isTrusted ? deps.makeSubprocess() : deps.makePyodide();
}

/** Wraps a primary engine (subprocess) and, the first time it reports djLint
is unavailable, transparently switches to a lazily-created secondary (bundled
Pyodide) for that call and every call after — logging one info line instead of
the old blocking "not installed" error. */
export class FallbackEngine implements DjlintEngine {
  #secondary: DjlintEngine | undefined;
  #switched = false;
  #disposed = false;

  constructor(
    private readonly primary: DjlintEngine,
    private readonly makeSecondary: () => DjlintEngine,
    private readonly outputChannel: vscode.LogOutputChannel,
  ) {}

  async format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    if (this.#switched) {
      return this.#secondaryEngine().format(
        document,
        config,
        formattingOptions,
        token,
      );
    }
    try {
      return await this.primary.format(
        document,
        config,
        formattingOptions,
        token,
      );
    } catch (e) {
      this.#switchOrThrow(e);
      return this.#secondaryEngine().format(
        document,
        config,
        formattingOptions,
        token,
      );
    }
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    if (this.#switched) {
      return this.#secondaryEngine().lint(document, config, token);
    }
    try {
      return await this.primary.lint(document, config, token);
    } catch (e) {
      this.#switchOrThrow(e);
      return this.#secondaryEngine().lint(document, config, token);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.primary.dispose();
    this.#secondary?.dispose();
  }

  #secondaryEngine(): DjlintEngine {
    // Dispose is terminal: never build a secondary (and its Pyodide worker) for an engine already invalidated mid-call.
    if (this.#disposed) {
      throw new vscode.CancellationError();
    }
    this.#secondary ??= this.makeSecondary();
    return this.#secondary;
  }

  #switchOrThrow(e: unknown): void {
    if (!(e instanceof DjlintUnavailableError)) {
      throw e;
    }
    if (!this.#switched) {
      this.#switched = true;
      this.outputChannel.info(
        "djLint not found in the environment; using the bundled runtime.",
      );
    }
  }
}

const state: { cached: DjlintEngine | undefined } = { cached: void 0 };

export function getEngine(
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel,
): DjlintEngine {
  if (state.cached) {
    return state.cached;
  }
  const workerPath = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "pyodide-worker.cjs",
  ).fsPath;
  const indexURL = vscode.Uri.joinPath(
    context.extensionUri,
    "assets",
    "pyodide",
  ).fsPath;
  function makePyodide(): DjlintEngine {
    return new PyodideEngine(workerPath, indexURL);
  }
  state.cached = selectEngine<DjlintEngine>({
    isTrusted: vscode.workspace.isTrusted,
    makePyodide,
    makeSubprocess: (): DjlintEngine =>
      new FallbackEngine(
        new SubprocessEngine(outputChannel),
        makePyodide,
        outputChannel,
      ),
  });
  return state.cached;
}

export function disposeEngine(): void {
  state.cached?.dispose();
  state.cached = void 0;
}

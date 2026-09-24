import * as vscode from "vscode";
import { workspaceScopeKey } from "../paths.js";
import { PyodideEngine } from "./pyodide/index.js";
import { SubprocessEngine } from "./subprocess/index.js";
import {
  DjlintUnavailableError,
  RESOLUTION_TTL_MS,
  type DjlintEngine,
  type LintDiagnostic,
} from "./types.js";

export class FallbackEngine implements DjlintEngine {
  #secondary: DjlintEngine | undefined;
  readonly #unavailableUntil = new Map<string, number>();
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
    return this.#dispatch(document, async (engine) =>
      engine.format(document, config, formattingOptions, token),
    );
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    return this.#dispatch(document, async (engine) =>
      engine.lint(document, config, token),
    );
  }

  dispose(): void {
    this.#disposed = true;
    this.primary.dispose();
    this.#secondary?.dispose();
  }

  async #dispatch<R>(
    document: vscode.TextDocument,
    call: (engine: DjlintEngine) => Promise<R>,
  ): Promise<R> {
    const scope = workspaceScopeKey(document);
    const until = this.#unavailableUntil.get(scope);
    if (until != null && Date.now() < until) {
      return call(this.#secondaryEngine());
    }
    try {
      return await call(this.primary);
    } catch (e) {
      this.#markUnavailableOrThrow(scope, e);
      return call(this.#secondaryEngine());
    }
  }

  #secondaryEngine(): DjlintEngine {
    if (this.#disposed) {
      throw new vscode.CancellationError();
    }
    this.#secondary ??= this.makeSecondary();
    return this.#secondary;
  }

  #markUnavailableOrThrow(scope: string, e: unknown): void {
    if (!(e instanceof DjlintUnavailableError)) {
      throw e;
    }
    const wasAlreadyMarked =
      (this.#unavailableUntil.get(scope) ?? 0) > Date.now();
    this.#unavailableUntil.set(scope, Date.now() + RESOLUTION_TTL_MS);
    if (!wasAlreadyMarked) {
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
    return new PyodideEngine(workerPath, indexURL, outputChannel);
  }
  state.cached = vscode.workspace.isTrusted
    ? new FallbackEngine(
        new SubprocessEngine(outputChannel),
        makePyodide,
        outputChannel,
      )
    : makePyodide();
  return state.cached;
}

export function disposeEngine(): void {
  state.cached?.dispose();
  state.cached = void 0;
}

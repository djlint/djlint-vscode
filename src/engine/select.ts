import * as vscode from "vscode";
import { PyodideEngine } from "./pyodide/index.js";
import { RESOLUTION_TTL_MS } from "./subprocess/constants.js";
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
VS Code dependency, so it is unit-testable in isolation. A trusted host
tries the environment djLint (wrapped in `FallbackEngine` so it falls back
to the bundled runtime when unavailable); an untrusted workspace always
gets the sandboxed bundled runtime — we never run an environment tool on
untrusted content. */
export function selectEngine<T>(deps: EngineSelectionDeps<T>): T {
  return deps.isTrusted ? deps.makeSubprocess() : deps.makePyodide();
}

/** The per-scope key `FallbackEngine` remembers a "primary unavailable"
verdict under: the document's workspace folder (mirroring, not importing,
`runner.ts`'s `resolutionScopeKey()`, to avoid pulling in `execa`), always
as a `string` (`""` for "no workspace folder") to key a plain `Map`. */
function fallbackScopeKey(document: vscode.TextDocument): string {
  return (
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? ""
  );
}

/** Wraps a primary engine and, whenever it reports djLint unavailable for a
scope, switches that scope to a lazily-created secondary (bundled Pyodide)
for `RESOLUTION_TTL_MS`, self-healing once the TTL elapses. The secondary
is shared across every scope. */
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

  /** Shared `format()`/`lint()` flow: within the unavailable-until window,
  go straight to the secondary; otherwise try the primary and fall back on
  `DjlintUnavailableError`. Other errors propagate untouched. */
  async #dispatch<R>(
    document: vscode.TextDocument,
    call: (engine: DjlintEngine) => Promise<R>,
  ): Promise<R> {
    const scope = fallbackScopeKey(document);
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
    // Dispose is terminal: never build a secondary for an already-invalidated engine.
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
    // Reached at most once per RESOLUTION_TTL_MS window per scope, so this can't spam the log.
    this.outputChannel.info(
      "djLint not found in the environment; using the bundled runtime.",
    );
    this.#unavailableUntil.set(scope, Date.now() + RESOLUTION_TTL_MS);
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

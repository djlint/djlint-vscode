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
VS Code dependency, so it is unit-testable in isolation.

- A trusted desktop host tries the environment djLint (`makeSubprocess`
  always wraps it so it transparently falls back to the bundled runtime when
  djLint is unavailable — see `FallbackEngine`).
- An untrusted workspace ALWAYS gets the sandboxed bundled runtime: we never
  execute an environment tool on untrusted content. */
export function selectEngine<T>(deps: EngineSelectionDeps<T>): T {
  return deps.isTrusted ? deps.makeSubprocess() : deps.makePyodide();
}

/** The per-scope key `FallbackEngine` remembers a "primary unavailable"
verdict under: the document's workspace folder, mirroring `runner.ts`'s
`resolutionScopeKey()` (kept separate rather than imported — importing it
would pull `runner.ts`'s own dependencies, namely `execa` and the
Python-extension integration, into every consumer of this module) — so a
multi-root workspace's folders (each potentially with their own
interpreter/virtualenv) fall back independently: one folder's missing
djLint cannot force a sibling folder with a working djLint onto the bundled
runtime. Unlike `resolutionScopeKey()` (which returns `string | undefined`,
`undefined` meaning the shared global scope), this always returns a
`string` — `""` is the stable fallback key for that same "no workspace
folder" scope — so it can key a plain `Map<string, number>`. */
function fallbackScopeKey(document: vscode.TextDocument): string {
  return (
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? ""
  );
}

/** Wraps a primary engine (subprocess) and, whenever it reports djLint is
unavailable for a given document's workspace-folder scope (see
`fallbackScopeKey()`), transparently switches that scope to a
lazily-created secondary (bundled Pyodide) for `RESOLUTION_TTL_MS` —
logging one info line per newly-unavailable scope instead of the old
blocking "not installed" error. The verdict self-heals: once the TTL
elapses, the next call for that scope retries the primary, so an in-place
`pip install djlint` (or a venv rebuild) is picked up without restarting
the extension — mirroring how `runner.ts`'s own command-resolution cache
self-heals on the same TTL. The secondary (bundled Pyodide) is shared
across every scope, since the bundled runtime is independent of the
workspace's Python environment. */
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

  /** Shared `format()`/`lint()` flow: if `document`'s scope is currently
  within its unavailable-until window, go straight to the secondary (no
  primary attempt, so a healthy sibling scope is never dragged down);
  otherwise try the primary, and on a `DjlintUnavailableError` mark the
  scope unavailable for `RESOLUTION_TTL_MS` and retry on the secondary. Any
  other error propagates without touching the fallback state. */
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
    // Dispose is terminal: never build a secondary (and its Pyodide worker) for an engine already invalidated mid-call.
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
    // #dispatch() only reaches here after an actual (uncached) primary attempt just failed for this scope, which happens at most once per RESOLUTION_TTL_MS window — so this can't spam the log on every format/lint call.
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

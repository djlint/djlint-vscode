import * as vscode from "vscode";
import { getConfiguredPath } from "../config.js";
import { isVirtualDocument, workspaceScopeKey } from "../paths.js";
import {
  DjlintUnavailableError,
  RESOLUTION_TTL_MS,
  type DjlintEngine,
  type LintDiagnostic,
} from "./types.js";

export const engineSettingKeys: readonly string[] = [
  "executablePath",
  "importStrategy",
  "pythonPath",
  "useVenv",
];

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
    return this.#dispatch(document, config, async (engine) =>
      engine.format(document, config, formattingOptions, token),
    );
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    return this.#dispatch(document, config, async (engine) =>
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
    config: vscode.WorkspaceConfiguration,
    call: (engine: DjlintEngine) => Promise<R>,
  ): Promise<R> {
    // Only the bundled djLint can read the configuration of a virtual workspace.
    const shouldPreferBundled =
      isVirtualDocument(document) &&
      !getConfiguredPath(config, "executablePath") &&
      !getConfiguredPath(config, "pythonPath");
    if (
      shouldPreferBundled ||
      config.get<string>("importStrategy") === "useBundled"
    ) {
      return call(this.#secondaryEngine());
    }
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

export class EngineManager implements vscode.Disposable {
  #engine: DjlintEngine | undefined;

  constructor(private readonly createEngine: () => DjlintEngine) {}

  get engine(): DjlintEngine {
    this.#engine ??= this.createEngine();
    return this.#engine;
  }

  reset(): void {
    this.#engine?.dispose();
    this.#engine = void 0;
  }

  dispose(): void {
    this.reset();
  }
}

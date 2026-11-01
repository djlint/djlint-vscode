import * as vscode from "vscode";
import { getConfiguredPath } from "../config.js";
import { isVirtualDocument, workspaceScopeKey } from "../paths.js";
import { DjlintUnavailableError } from "./types.js";
import type { DjlintEngine, LintDiagnostic } from "./types.js";

export const engineSettingKeys: readonly string[] = [
  "executablePath",
  "importStrategy",
  "pythonPath",
  "useVenv",
];

export class FallbackEngine implements DjlintEngine {
  #secondary: DjlintEngine | undefined;
  readonly #fallbackLogged = new Set<string>();
  #disposed = false;
  readonly #primary: DjlintEngine;
  readonly #makeSecondary: () => DjlintEngine;
  readonly #outputChannel: vscode.LogOutputChannel;

  constructor(
    primary: DjlintEngine,
    makeSecondary: () => DjlintEngine,
    outputChannel: vscode.LogOutputChannel,
  ) {
    this.#primary = primary;
    this.#makeSecondary = makeSecondary;
    this.#outputChannel = outputChannel;
  }

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
    return this.#dispatch(document, config, async (engine) => engine.lint(document, config, token));
  }

  dispose(): void {
    this.#disposed = true;
    this.#primary.dispose();
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
    if (shouldPreferBundled || config.get<string>("importStrategy") === "useBundled") {
      return call(this.#secondaryEngine());
    }
    try {
      return await call(this.#primary);
    } catch (e) {
      if (!(e instanceof DjlintUnavailableError)) {
        throw e;
      }
      this.#logFallback(workspaceScopeKey(document));
      return call(this.#secondaryEngine());
    }
  }

  #secondaryEngine(): DjlintEngine {
    if (this.#disposed) {
      throw new vscode.CancellationError();
    }
    this.#secondary ??= this.#makeSecondary();
    return this.#secondary;
  }

  #logFallback(scope: string): void {
    if (this.#fallbackLogged.has(scope)) {
      return;
    }
    this.#fallbackLogged.add(scope);
    this.#outputChannel.info("djLint not found in the environment; using the bundled runtime.");
  }
}

export class EngineManager implements vscode.Disposable {
  #engine: DjlintEngine | undefined;
  readonly #createEngine: () => DjlintEngine;

  constructor(createEngine: () => DjlintEngine) {
    this.#createEngine = createEngine;
  }

  get engine(): DjlintEngine {
    this.#engine ??= this.#createEngine();
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

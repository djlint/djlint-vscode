import type * as vscode from "vscode";
import type { PythonEnvironments } from "../python/environment.js";
import { SubprocessEngine } from "./subprocess/index.js";
import type { DjlintEngine } from "./types.js";

export const engineSettingKeys: readonly string[] = [
  "executablePath",
  "pythonPath",
  "useVenv",
];

export class EngineManager implements vscode.Disposable {
  #engine: DjlintEngine | undefined;

  constructor(
    private readonly outputChannel: vscode.LogOutputChannel,
    private readonly pythonEnvironments: PythonEnvironments,
  ) {}

  get engine(): DjlintEngine {
    this.#engine ??= new SubprocessEngine(
      this.outputChannel,
      this.pythonEnvironments,
    );
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

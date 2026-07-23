import type * as vscode from "vscode";
import { SubprocessEngine } from "./subprocess/index.js";
import type { DjlintEngine } from "./types.js";

export interface EngineSelectionDeps<T> {
  importStrategy: "fromEnvironment" | "useBundled";
  isTrusted: boolean;
  makeSubprocess: () => T;
  makePyodide: () => T;
}

/** Pure decision: which engine factory to invoke, given the
`djlint.importStrategy` setting and workspace-trust state. No VS Code
dependency, so it is unit-testable in isolation. Runtime fallback (e.g. when
the subprocess engine turns out to be unavailable) is handled at call time
by the caller, not here. */
export function selectEngine<T>(deps: EngineSelectionDeps<T>): T {
  if (!deps.isTrusted || deps.importStrategy === "useBundled") {
    return deps.makePyodide();
  }
  return deps.makeSubprocess();
}

const state: { cached: DjlintEngine | undefined } = { cached: void 0 };

export function getEngine(
  outputChannel: vscode.LogOutputChannel,
): DjlintEngine {
  state.cached ??= new SubprocessEngine(outputChannel);
  return state.cached;
}

export function disposeEngine(): void {
  state.cached?.dispose();
  state.cached = void 0;
}

import type * as vscode from "vscode";
import { SubprocessEngine } from "./subprocess/index.js";
import type { DjlintEngine } from "./types.js";

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

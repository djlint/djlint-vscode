import type * as vscode from "vscode";
import { formattingArgs, lintingArgs } from "../args.js";
import type { DjlintMode } from "./types.js";

export function buildConfigKwargs(
  config: vscode.WorkspaceConfiguration,
  formattingOptions: vscode.FormattingOptions | undefined,
  mode: DjlintMode,
): Record<string, unknown> {
  const args = mode === "format" ? formattingArgs : lintingArgs;
  const kwargs: Record<string, unknown> = {};
  for (const arg of args) {
    const pair = arg.buildKwarg(config, formattingOptions);
    if (pair != null) {
      const [name, value] = pair;
      kwargs[name] = value;
    }
  }
  return kwargs;
}

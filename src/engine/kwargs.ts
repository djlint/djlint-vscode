import type * as vscode from "vscode";
import { formattingArgs, lintingArgs } from "../args.js";

/** Builds the djLint `Config(**kwargs)` equivalent of the CLI flags for the
given mode, so the in-process (Pyodide) engine matches the subprocess path. */
export function buildConfigKwargs(
  config: vscode.WorkspaceConfiguration,
  formattingOptions: vscode.FormattingOptions | undefined,
  mode: "format" | "lint",
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

import type * as vscode from "vscode";
import { formattingArgs, lintingArgs } from "../args.js";

/** Builds the djLint `Config(**kwargs)` equivalent of the CLI flags the
extension would pass for the given mode, so the in-process (Pyodide) engine
formats/lints identically to the subprocess path. */
export function buildConfigKwargs(
  config: vscode.WorkspaceConfiguration,
  document: vscode.TextDocument,
  formattingOptions: vscode.FormattingOptions | undefined,
  mode: "format" | "lint",
): Record<string, unknown> {
  const args = mode === "format" ? formattingArgs : lintingArgs;
  const kwargs: Record<string, unknown> = {};
  for (const arg of args) {
    const pair = arg.buildKwarg(config, document, formattingOptions);
    if (pair != null) {
      const [name, value] = pair;
      kwargs[name] = value;
    }
  }
  return kwargs;
}

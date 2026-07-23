import type * as vscode from "vscode";

export interface LintDiagnostic {
  // 1-based, as djLint emits
  line: number;
  // 0-based
  column: number;
  code: string;
  message: string;
}

export interface DjlintEngine {
  format: (
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ) => Promise<string>;

  lint: (
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ) => Promise<LintDiagnostic[]>;

  dispose: () => void;
}

/** Thrown when an engine cannot run at all (missing tool/interpreter), so the
selector may fall back to another engine. Distinct from a djLint runtime/lint
error, which must propagate. */
export class DjlintUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DjlintUnavailableError";
  }
}

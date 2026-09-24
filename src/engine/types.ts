import type * as vscode from "vscode";

export const RESOLUTION_TTL_MS = 5 * 60 * 1000;

export const RUN_TIMEOUT_MS = 120_000;

export type DjlintMode = "format" | "lint";

export interface LintDiagnostic {
  line: number;
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

export class DjlintUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DjlintUnavailableError";
  }
}

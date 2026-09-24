import type * as vscode from "vscode";
import { runDjlint } from "../../runner.js";
import type { DjlintEngine, LintDiagnostic } from "../types.js";
import { parseLinterOutput } from "./parse-lint-output.js";

function abortSignalFor(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller.signal;
}

export class SubprocessEngine implements DjlintEngine {
  constructor(private readonly outputChannel: vscode.LogOutputChannel) {}

  async format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    return runDjlint(
      document,
      config,
      "format",
      this.outputChannel,
      abortSignalFor(token),
      formattingOptions,
    );
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    const stdout = await runDjlint(
      document,
      config,
      "lint",
      this.outputChannel,
      abortSignalFor(token),
    );
    return parseLinterOutput(stdout);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/no-empty-function
  dispose(): void {}
}

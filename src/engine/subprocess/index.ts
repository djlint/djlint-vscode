import type * as vscode from "vscode";
import { formattingArgs, lintingArgs } from "../../args.js";
import { runDjlint } from "../../runner.js";
import type { DjlintEngine, LintDiagnostic } from "../types.js";
import { parseLinterOutput } from "./parse-lint-output.js";

function controllerFor(token: vscode.CancellationToken): AbortController {
  const controller = new AbortController();
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller;
}

export class SubprocessEngine implements DjlintEngine {
  constructor(private readonly outputChannel: vscode.LogOutputChannel) {}

  // `runDjlint()` already decides -- in one place -- whether a failure means djLint is unavailable (throwing DjlintUnavailableError, for FallbackEngine to catch) or is a genuine error (already surfaced via checkErrors()'s popup and rethrown), so there is nothing left to classify here: both methods just pass its promise straight through.
  async format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    return runDjlint(
      document,
      config,
      formattingArgs,
      this.outputChannel,
      controllerFor(token),
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
      lintingArgs,
      this.outputChannel,
      controllerFor(token),
    );
    return parseLinterOutput(stdout);
  }

  // Nothing to dispose: each format/lint call owns its own AbortController.
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/no-empty-function
  dispose(): void {}
}

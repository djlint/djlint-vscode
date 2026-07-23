import type * as vscode from "vscode";
import { formattingArgs, lintingArgs } from "../../args.js";
import { isCustomExecaError, runDjlint } from "../../runner.js";
import {
  DjlintUnavailableError,
  type DjlintEngine,
  type LintDiagnostic,
} from "../types.js";
import { parseLinterOutput } from "./parse-lint-output.js";

function controllerFor(token: vscode.CancellationToken): AbortController {
  const controller = new AbortController();
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller;
}

function asUnavailable(e: unknown): never {
  if (
    isCustomExecaError(e) &&
    (e.code === "ENOENT" || /No\s+module\s+named\s+djlint/u.test(e.stderr))
  ) {
    throw new DjlintUnavailableError("External djLint is not available.", {
      cause: e,
    });
  }
  throw e;
}

export class SubprocessEngine implements DjlintEngine {
  constructor(
    private readonly outputChannel: vscode.LogOutputChannel,
    // When true (a bundled fallback exists), surface "djLint unavailable" quietly (no popup) so the caller can switch engines.
    private readonly hasFallback = false,
  ) {}

  async format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    try {
      return await runDjlint(
        document,
        config,
        formattingArgs,
        this.outputChannel,
        controllerFor(token),
        formattingOptions,
        this.hasFallback,
      );
    } catch (e) {
      return asUnavailable(e);
    }
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    let stdout: string;
    try {
      stdout = await runDjlint(
        document,
        config,
        lintingArgs,
        this.outputChannel,
        controllerFor(token),
        void 0,
        this.hasFallback,
      );
    } catch (e) {
      asUnavailable(e);
    }
    return parseLinterOutput(
      stdout,
      config.get<boolean>("useNewLinterOutputParser") ?? true,
    );
  }

  // Nothing to dispose: each format/lint call owns its own AbortController.
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/no-empty-function
  dispose(): void {}
}

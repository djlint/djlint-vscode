import * as vscode from "vscode";
import { formattingArgs, lintingArgs, type CliArg } from "./args.js";
import type { CustomExecaError } from "./runner.js";

const argsMap: ReadonlyMap<string, CliArg> = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg]),
);

const installDocsUrl = "https://djlint.com/docs/getting-started/";
const readmeUrl = "https://github.com/djlint/djLint/blob/master/README.md";

function showError(
  e: Error,
  outputChannel: vscode.LogOutputChannel,
  userMessage?: string,
): void {
  // Pass the Error itself: JSON.stringify(Error) drops message and stack.
  outputChannel.error(e);
  void (async (): Promise<void> => {
    const item = await vscode.window.showErrorMessage(
      userMessage ?? e.message,
      "Details",
    );
    if (item != null) {
      outputChannel.show();
    }
  })();
}

/** True when a failed djLint invocation's non-zero exit is actually a valid
lint result: for a *lint* request only, djLint exits exactly `1` (its
documented "found violations" code -- not just any non-zero exit) and
prints its normal "Linting N/M files" progress (or nothing) on stderr. A
*format* request never has a valid non-zero-exit result: a silent
formatter failure must not be mistaken for formatted output, so `isLint`
short-circuits this to `false` regardless of exit code/stderr shape. */
export function isValidLintResult(
  e: CustomExecaError,
  isLint: boolean,
): boolean {
  return (
    isLint &&
    e.exitCode === 1 &&
    /(?:^$|Linting\s+\d+\/\d+\s+files)/u.test(e.stderr)
  );
}

export function checkErrors(
  e: CustomExecaError,
  outputChannel: vscode.LogOutputChannel,
): CustomExecaError {
  // No isValidLintResult() early return here: runDjlint()'s classifyRunFailure() call already ruled that out (for both lint and format requests) before falling through to this function, so re-checking it here would be dead code.
  if (e.exitCode != null) {
    const option = /No\s+such\s+option:\s*(?<option>\S+)/u.exec(e.stderr)
      ?.groups?.["option"];
    if (option) {
      const arg = argsMap.get(option);
      if (arg) {
        const optionName = arg.displayName;
        const errMsg = `Your version of djLint does not support the \`${optionName}\` option. Disable it in the settings or update djLint to version ${arg.minVersion} or newer. See update instructions at ${installDocsUrl} or ${readmeUrl}.`;
        showError(e, outputChannel, errMsg);
      } else {
        showError(e, outputChannel);
      }
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw e;
    }
  }

  if (!e.isCanceled) {
    showError(e, outputChannel);
  }
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw e;
}

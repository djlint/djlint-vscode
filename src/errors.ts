import * as vscode from "vscode";
import { formattingArgs, lintingArgs, type CliArg } from "./args.js";
import type { CustomExecaError } from "./runner.js";

const argsMap: ReadonlyMap<string, CliArg> = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg]),
);

const installDocsUrl = "https://djlint.com/docs/getting-started/";
const readmeUrl = "https://github.com/djlint/djLint/blob/master/README.md";

function errorToOutputChannel(
  outputChannel: vscode.LogOutputChannel,
  e: Error,
): void {
  // Pass the Error itself: JSON.stringify(Error) drops message and stack.
  outputChannel.error(e);
}

function showError(
  e: Error,
  outputChannel: vscode.LogOutputChannel,
  userMessage?: string,
): void {
  errorToOutputChannel(outputChannel, e);
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
lint result: djLint exits `1` and prints its normal "Linting N/M files"
progress (or nothing) on stderr when it finds violations. Also reused by
`checkErrors()` below so the two checks can't drift apart. */
export function isValidLintResult(e: CustomExecaError): boolean {
  return (
    e.exitCode != null && /(?:^$|Linting\s+\d+\/\d+\s+files)/u.test(e.stderr)
  );
}

export function checkErrors(
  e: CustomExecaError,
  outputChannel: vscode.LogOutputChannel,
): CustomExecaError {
  if (isValidLintResult(e)) {
    return e;
  }

  if (e.exitCode != null) {
    const option = /No\s+such\s+option:\s*(?<option>\S+)/u.exec(e.stderr)
      ?.groups?.["option"];
    if (option) {
      const arg = argsMap.get(option);
      if (arg) {
        const optionName = arg.vscodeName
          ? `djlint.${arg.vscodeName}`
          : arg.cliName;
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

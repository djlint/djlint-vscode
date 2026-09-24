import type * as vscode from "vscode";
import { formattingArgs, lintingArgs, type CliArg } from "./args.js";
import type { CustomExecaError } from "./engine/subprocess/exec.js";
import { showFailure } from "./notify.js";

const argsMap: ReadonlyMap<string, CliArg> = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg]),
);

const installDocsUrl = "https://djlint.com/docs/getting-started/";

const NO_SUCH_OPTION_REGEX =
  /No\s+such\s+option[:\s]\s*['"]?(?<option>--[\w-]+)/u;

function summarize(e: CustomExecaError): string {
  const lastLine = e.stderr
    .split("\n")
    .map((line) => line.trim())
    .findLast(Boolean);
  return lastLine ? `djLint failed: ${lastLine}` : e.shortMessage;
}

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
): never {
  const rejectedOption =
    e.exitCode == null
      ? void 0
      : NO_SUCH_OPTION_REGEX.exec(e.stderr)?.groups?.["option"];
  const arg = rejectedOption == null ? void 0 : argsMap.get(rejectedOption);

  outputChannel.error(e);
  void showFailure(
    arg
      ? `Your version of djLint does not support the \`${arg.displayName}\` option. Disable it in the settings or update djLint to version ${arg.minVersion} or newer. See update instructions at ${installDocsUrl}.`
      : summarize(e),
    outputChannel,
  );

  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw e;
}

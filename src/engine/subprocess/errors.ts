import * as vscode from "vscode";

import { formattingArgs, lintingArgs } from "../../args.js";
import type { CliArg } from "../../args.js";
import { docsUrl } from "../../docs.js";
import { lastLine, showFailure } from "../../notify.js";
import type { CustomExecaError } from "./exec.js";

const argsMap: ReadonlyMap<string, CliArg> = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg]),
);

const NO_SUCH_OPTION_REGEX = /No\s+such\s+option[:\s]\s*['"]?(?<option>--[\w-]+)/u;

function summarize(e: CustomExecaError): string {
  const reason = lastLine(e.stderr);
  if (reason) {
    return vscode.l10n.t("djLint failed: {0}", reason);
  }
  if (e.timedOut) {
    return vscode.l10n.t("djLint did not finish in time.");
  }
  if (e.exitCode != null) {
    return vscode.l10n.t("djLint failed with exit code {0}.", e.exitCode);
  }
  return e.signal == null
    ? vscode.l10n.t("djLint could not start: {0}.", e.code ?? vscode.l10n.t("unknown error"))
    : vscode.l10n.t("djLint was stopped by {0}.", e.signal);
}

export function isValidLintResult(e: CustomExecaError, isLint: boolean): boolean {
  return (
    isLint &&
    e.exitCode === 1 &&
    (e.stdout.trim() !== "" || /(?:^$|Linting\s+\d+\/\d+\s+files)/u.test(e.stderr))
  );
}

export function checkErrors(e: CustomExecaError, outputChannel: vscode.LogOutputChannel): never {
  const rejectedOption =
    e.exitCode == null ? void 0 : NO_SUCH_OPTION_REGEX.exec(e.stderr)?.groups?.["option"];
  const arg = rejectedOption == null ? void 0 : argsMap.get(rejectedOption);

  outputChannel.error(e);
  void showFailure(
    arg
      ? vscode.l10n.t(
          "Your version of djLint does not support the `{0}` option. Disable it in the settings or update djLint to version {1} or newer. See update instructions at {2}.",
          arg.displayName,
          arg.minVersion,
          docsUrl("getting-started/"),
        )
      : summarize(e),
    outputChannel,
  );

  // oxlint-disable-next-line typescript/only-throw-error
  throw e;
}

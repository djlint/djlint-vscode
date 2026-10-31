import * as vscode from "vscode";
import { formattingArgs, lintingArgs, type CliArg } from "../../args.js";
import { lastLine, showFailure } from "../../notify.js";
import type { CustomExecaError } from "./exec.js";

const argsMap: ReadonlyMap<string, CliArg> = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg]),
);

const installDocsUrl = "https://djlint.com/docs/getting-started/";

const extReadmeUrl = "https://github.com/djlint/djlint-vscode#installation";

const NO_SUCH_OPTION_REGEX =
  /No\s+such\s+option[:\s]\s*['"]?(?<option>--[\w-]+)/u;

function summarize(e: CustomExecaError): string {
  const reason = lastLine(e.stderr);
  return reason ? `djLint failed: ${reason}` : e.shortMessage;
}

export function showInstallError(
  config: vscode.WorkspaceConfiguration,
  outputChannel: vscode.LogOutputChannel,
): void {
  const configName = "showInstallError";
  if (!config.get<boolean>(configName)) {
    return;
  }
  void (async (): Promise<void> => {
    const choice = await vscode.window.showErrorMessage(
      `djLint is not installed or cannot be executed with the current extension settings. See installation instructions at ${extReadmeUrl}.`,
      "Do not show again (workspace)",
      "Do not show again (global)",
      "Details",
    );
    // eslint-disable-next-line default-case, @typescript-eslint/switch-exhaustiveness-check
    switch (choice) {
      case "Do not show again (workspace)": {
        void config.update(
          configName,
          false,
          vscode.ConfigurationTarget.Workspace,
        );
        break;
      }
      case "Do not show again (global)": {
        void config.update(
          configName,
          false,
          vscode.ConfigurationTarget.Global,
        );
        break;
      }
      case "Details": {
        outputChannel.show();
        break;
      }
    }
  })();
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

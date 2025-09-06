import * as vscode from "vscode";
import { formattingArgs, lintingArgs, type CliArg } from "./args.js";
import type { CustomExecaError } from "./runner.js";

const argsMap: ReadonlyMap<string, CliArg> = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg]),
);

function errorToOutputChannel(
  outputChannel: vscode.LogOutputChannel,
  e: Error,
): void {
  outputChannel.error(JSON.stringify(e, null, "\t"));
}

function showError(
  e: Error,
  outputChannel: vscode.LogOutputChannel,
  userMessage?: string,
): void {
  errorToOutputChannel(outputChannel, e);
  void vscode.window
    .showErrorMessage(userMessage ?? e.message, "Details")
    .then((item) => {
      if (item != null) {
        outputChannel.show();
      }
    });
}

class NotAnErrorHandler {
  static check(stderr: string): NotAnErrorHandler | undefined {
    return /(?:^$|Linting\s+\d+\/\d+\s+files)/u.test(stderr)
      ? new this()
      : void 0;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/no-empty-function
  handle(): void {}
}

class DjlintNotInstalledHandler {
  static check(stderr: string): DjlintNotInstalledHandler | undefined {
    return /No\s+module\s+named\s+djlint/u.test(stderr) ? new this() : void 0;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  handle(
    e: Error,
    outputChannel: vscode.LogOutputChannel,
    config: vscode.WorkspaceConfiguration,
    pythonExec: string,
  ): never {
    errorToOutputChannel(outputChannel, e);

    const configName = "showInstallError";
    if (config.get<boolean>(configName)) {
      const errMsg = `djLint is not installed for the current active Python interpreter. Install it with the \`${pythonExec} -m pip install -U djlint\` command.`;
      void vscode.window
        .showErrorMessage(
          errMsg,
          "Do not show again (workspace)",
          "Do not show again (global)",
          "Details",
        )
        .then((choice) => {
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
        });
    }
    throw e;
  }
}

class NoSuchOptionHandler {
  readonly #option: string;

  private constructor(option: string) {
    this.#option = option;
  }

  static check(stderr: string): NoSuchOptionHandler | undefined {
    const option = /No\s+such\s+option:\s*(?<option>\S+)/u.exec(stderr)
      ?.groups?.["option"];
    return option ? new this(option) : void 0;
  }

  handle(
    e: Error,
    outputChannel: vscode.LogOutputChannel,
    _config: vscode.WorkspaceConfiguration,
    pythonExec: string,
  ): never {
    const arg = argsMap.get(this.#option);
    if (arg) {
      const option = arg.vscodeName ? `djlint.${arg.vscodeName}` : arg.cliName;
      const errMsg = `Your version of djLint does not support the \`${option}\` option. Disable it in the settings or update djLint with the \`${pythonExec} -m pip install -U djlint>=${arg.minVersion}\` command.`;
      showError(e, outputChannel, errMsg);
    } else {
      showError(e, outputChannel);
    }
    throw e;
  }
}

const errorHandlers = [
  NotAnErrorHandler,
  DjlintNotInstalledHandler,
  NoSuchOptionHandler,
] as const;

export function checkErrors(
  e: CustomExecaError,
  outputChannel: vscode.LogOutputChannel,
  config: vscode.WorkspaceConfiguration,
  pythonExec: string,
): CustomExecaError {
  if (e.exitCode != null) {
    for (const errorHandlerType of errorHandlers) {
      const errorHandler = errorHandlerType.check(e.stderr);
      if (errorHandler != null) {
        errorHandler.handle(e, outputChannel, config, pythonExec);
        return e;
      }
    }
  }

  if (!e.isCanceled) {
    showError(e, outputChannel);
  }
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw e;
}

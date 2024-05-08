import { PythonExtension } from "@vscode/python-extension";
import { execa, type ExecaError } from "execa";
import * as vscode from "vscode";
import { configurationArg, type CliArg } from "./args";
import { configSection } from "./config";
import { checkErrors, ErrorMessageWrapper } from "./errors";
import { noop } from "./utils";

async function getPythonExec(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
): Promise<string> {
  if (config.get<boolean>("useVenv")) {
    const api = await PythonExtension.api().catch(noop);
    if (api) {
      const environment = await api.environments.resolveEnvironment(
        api.environments.getActiveEnvironmentPath(document.uri),
      );
      const pythonExecUri = environment?.executable.uri;
      if (pythonExecUri) {
        return pythonExecUri.fsPath;
      }
      const msg = "Failed to get Python interpreter from Python extension.";
      throw new Error(msg);
    }
  }

  const pythonPath = config.get<string>("pythonPath");
  if (pythonPath) {
    return pythonPath;
  }

  const msg = `Invalid ${configSection}.pythonPath setting.`;
  throw new Error(msg);
}

function getCwd(
  childArgs: readonly string[],
  document: vscode.TextDocument,
  outputChannel: vscode.LogOutputChannel,
): Record<string, never> | { cwd: string } {
  if (childArgs.includes(configurationArg.cliName)) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder != null) {
      if (workspaceFolder.uri.scheme === "file") {
        return { cwd: workspaceFolder.uri.fsPath };
      }
      outputChannel.warn(
        `Unsupported URI scheme of "${workspaceFolder.uri.toString()}". Cwd will not be set.`,
      );
      return {};
    }
  }
  if (document.uri.scheme === "file") {
    const parentFolder = vscode.Uri.joinPath(document.uri, "..");
    return { cwd: parentFolder.fsPath };
  }
  outputChannel.warn(
    `Unsupported URI scheme of "${document.uri.toString()}". Cwd will not be set.`,
  );
  return {};
}

export async function runDjlint(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: readonly CliArg[],
  outputChannel: vscode.LogOutputChannel,
  formattingOptions?: vscode.FormattingOptions,
): Promise<string> {
  const pythonExec = await getPythonExec(document, config).catch((e: Error) => {
    void vscode.window.showErrorMessage(e.message);
    throw e;
  });
  const childArgs = [
    "-m",
    "djlint",
    "-",
    ...args.flatMap((arg) => arg.build(config, document, formattingOptions)),
  ];
  const childOptions = {
    ...getCwd(childArgs, document, outputChannel),
    input: document.getText(),
    stripFinalNewline: false,
  };
  return execa(pythonExec, childArgs, childOptions)
    .catch((e: ExecaError) => {
      checkErrors(e, pythonExec);
      return e;
    })
    .then(({ stdout }) => stdout as string)
    .catch((e: ErrorMessageWrapper<ExecaError> | ExecaError) => {
      void vscode.window.showErrorMessage(e.message, "Details").then((item) => {
        if (item != null) {
          outputChannel.show();
        }
      });
      if (e instanceof ErrorMessageWrapper) {
        e = e.wrappedError;
      }
      outputChannel.error(JSON.stringify(e, null, "\t"));
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw e;
    });
}

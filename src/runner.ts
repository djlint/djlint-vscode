import { execa, type ExecaError } from "execa";
import vscode from "vscode";
import { configurationArg, type CliArg } from "./args";
import { checkErrors, ErrorMessageWrapper } from "./errors";
import {
  PVSC_EXTENSION_ID,
  type PythonExtension,
} from "@vscode/python-extension";

async function getPythonExec(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
): Promise<string> {
  if (config.get<boolean>("useVenv")) {
    const pythonExtension =
      vscode.extensions.getExtension<PythonExtension>(PVSC_EXTENSION_ID);
    if (pythonExtension) {
      if (!pythonExtension.isActive) {
        await pythonExtension.activate();
      }
      const api = pythonExtension.exports;
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

  const msg = "Invalid djlint.pythonPath setting.";
  throw new Error(msg);
}

function getCwd(childArgs: string[], document: vscode.TextDocument): string {
  if (childArgs.includes(configurationArg.cliName)) {
    const cwd = vscode.workspace.getWorkspaceFolder(document.uri);
    if (cwd) {
      return cwd.uri.fsPath;
    }
  }
  return vscode.Uri.joinPath(document.uri, "..").fsPath;
}

export async function runDjlint(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: CliArg[],
  outputChannel: vscode.LogOutputChannel,
  formattingOptions?: vscode.FormattingOptions,
): Promise<string> {
  try {
    const pythonExec = await getPythonExec(document, config);
    const childArgs = ["-m", "djlint", "-"].concat(
      args.flatMap((arg) => arg.build(config, document, formattingOptions)),
    );
    const childOptions = {
      cwd: getCwd(childArgs, document),
      input: document.getText(),
      stripFinalNewline: false,
    };
    try {
      return (await execa(pythonExec, childArgs, childOptions)).stdout;
    } catch (e) {
      checkErrors(e as ExecaError, pythonExec);
      return (e as ExecaError).stdout;
    }
  } catch (e) {
    if (e instanceof Error) {
      void vscode.window.showErrorMessage(e.message);
      if (e instanceof ErrorMessageWrapper) {
        outputChannel.error(e.originalError);
        throw e.originalError;
      }
      outputChannel.error(e);
    }
    throw e;
  }
}

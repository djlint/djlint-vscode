import { execa, ExecaReturnValue, type ExecaError } from "execa";
import vscode from "vscode";
import { configurationArg, type CliArg } from "./args";
import { checkErrors, ErrorWithUserMessage } from "./errors";
import type { IExtensionApi } from "./pythonExtTypes";

async function getPythonExec(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration
): Promise<string> {
  if (config.get<boolean>("useVenv")) {
    const pythonExtension =
      vscode.extensions.getExtension<IExtensionApi>("ms-python.python");
    if (pythonExtension) {
      if (!pythonExtension.isActive) {
        await pythonExtension.activate();
      }
      const api = pythonExtension.exports;
      const environment = await api.environments.resolveEnvironment(
        api.environments.getActiveEnvironmentPath(document.uri)
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
  formattingOptions?: vscode.FormattingOptions
): Promise<string> {
  try {
    const pythonExec = await getPythonExec(document, config);
    const childArgs = ["-m", "djlint", "-"].concat(
      args.flatMap((arg) => arg.build(config, document, formattingOptions))
    );
    const childOptions = {
      input: document.getText(),
      stripFinalNewline: false,
      cwd: getCwd(childArgs, document),
    };
    let result: ExecaError | ExecaReturnValue;
    try {
      result = await execa(pythonExec, childArgs, childOptions);
    } catch (e) {
      const error = e as ExecaError;
      if ((error.exitCode as number | null | undefined) == null) {
        throw error;
      }
      result = error;
    }
    checkErrors(result.stderr, pythonExec);
    return result.stdout;
  } catch (e) {
    if (e instanceof Error) {
      const userMessage =
        e instanceof ErrorWithUserMessage ? e.userMessage : e.message;
      void vscode.window.showErrorMessage(userMessage);
      outputChannel.error(e);
    }
    throw e;
  }
}

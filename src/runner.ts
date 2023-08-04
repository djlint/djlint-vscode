import { PythonExtension } from "@vscode/python-extension";
import { execa } from "execa";
import vscode from "vscode";
import { configurationArg, type CliArg } from "./args";
import { configSection } from "./config";
import { checkErrors, ErrorMessageWrapper } from "./errors";

async function getPythonExec(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
): Promise<string> {
  if (config.get<boolean>("useVenv")) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const api = await PythonExtension.api().catch(() => {});
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
    const childArgs = [
      "-m",
      "djlint",
      "-",
      ...args.flatMap((arg) => arg.build(config, document, formattingOptions)),
    ];
    const childOptions = {
      cwd: getCwd(childArgs, document),
      input: document.getText(),
      stripFinalNewline: false,
    };
    const res = await execa(pythonExec, childArgs, childOptions).catch((e) => {
      checkErrors(e, pythonExec);
      return e;
    });
    return res.stdout;
  } catch (e) {
    if (e instanceof Error) {
      void vscode.window.showErrorMessage(e.message, "Details").then((item) => {
        if (item != null) {
          outputChannel.show();
        }
      });
      if (e instanceof ErrorMessageWrapper) {
        e = e.originalError;
      }
      outputChannel.error(JSON.stringify(e, null, 2));
    }
    throw e;
  }
}

import { spawn } from "child_process";
import vscode from "vscode";
import { configurationArg, type CliArg } from "./args";
import { getErrorMsg } from "./errorHandler";
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
      const errMsg = "Failed to get Python interpreter from Python extension.";
      void vscode.window.showErrorMessage(errMsg);
      throw new Error(errMsg);
    }
  }

  const pythonPath = config.get<string>("pythonPath");
  if (pythonPath) {
    return pythonPath;
  }

  const errMsg = "Invalid djlint.pythonPath setting.";
  void vscode.window.showErrorMessage(errMsg);
  throw new Error(errMsg);
}

function buildChildArgs(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: CliArg[],
  formattingOptions?: vscode.FormattingOptions
): string[] {
  return ["-m", "djlint", "-"].concat(
    args.flatMap((arg) => arg.build(config, document, formattingOptions))
  );
}

function buildChildOptions(
  childArgs: string[],
  document: vscode.TextDocument
): { cwd: string } {
  if (childArgs.includes(configurationArg.cliName)) {
    const cwd = vscode.workspace.getWorkspaceFolder(document.uri);
    if (cwd) {
      return { cwd: cwd.uri.fsPath };
    }
  }
  const cwd = vscode.Uri.joinPath(document.uri, "..");
  return { cwd: cwd.fsPath };
}

async function runChildProcess(
  pythonExec: string,
  childArgs: string[],
  childOptions: { cwd: string },
  document: vscode.TextDocument
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(pythonExec, childArgs, childOptions);
    child.stdin.write(document.getText());
    child.stdin.end();
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("close", () => {
      stderr = stderr.trim();
      const errMsg = getErrorMsg(stderr, pythonExec);
      if (errMsg) {
        void vscode.window.showErrorMessage(errMsg);
        reject(new Error(stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function runDjlint(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: CliArg[],
  formattingOptions?: vscode.FormattingOptions
): Promise<string> {
  const pythonExec = await getPythonExec(document, config);
  const childArgs = buildChildArgs(document, config, args, formattingOptions);
  const childOptions = buildChildOptions(childArgs, document);
  return runChildProcess(pythonExec, childArgs, childOptions, document);
}

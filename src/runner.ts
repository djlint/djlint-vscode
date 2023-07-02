import { spawn } from "child_process";
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
      throw new ErrorWithUserMessage(msg, msg);
    }
  }

  const pythonPath = config.get<string>("pythonPath");
  if (pythonPath) {
    return pythonPath;
  }

  const msg = "Invalid djlint.pythonPath setting.";
  throw new ErrorWithUserMessage(msg, msg);
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
      try {
        checkErrors(stderr, pythonExec);
        resolve(stdout);
      } catch (e) {
        reject(e);
      }
    });
  });
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
    const childArgs = buildChildArgs(document, config, args, formattingOptions);
    const childOptions = buildChildOptions(childArgs, document);
    return await runChildProcess(pythonExec, childArgs, childOptions, document);
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

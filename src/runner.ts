import { spawn } from "child_process";
import vscode from "vscode";
import { configurationArg, type CliArg } from "./args";
import { getErrorMsg } from "./errorHandler";
import { getPythonExec } from "./python";

function buildChildArgs(
  args: CliArg[],
  config: vscode.WorkspaceConfiguration,
  document: vscode.TextDocument,
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
      const errMsg = getErrorMsg(stderr);
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
  config: vscode.WorkspaceConfiguration,
  document: vscode.TextDocument,
  args: CliArg[],
  formattingOptions?: vscode.FormattingOptions
): Promise<string> {
  const pythonExec = await getPythonExec(document, config);
  const childArgs = buildChildArgs(args, config, document, formattingOptions);
  const childOptions = buildChildOptions(childArgs, document);
  return runChildProcess(pythonExec, childArgs, childOptions, document);
}

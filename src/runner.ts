import { spawn } from "child_process";
import * as vscode from "vscode";
import { CliArg } from "./args";
import { getErrorMsg } from "./errorHandler";
import { getPythonExec } from "./python";

export async function runDjlint(
  config: vscode.WorkspaceConfiguration,
  document: vscode.TextDocument,
  args: CliArg[],
  formattingOptions?: vscode.FormattingOptions
): Promise<string> {
  const pythonExec = await getPythonExec(document, config);
  return await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const childArgs = ["-m", "djlint", "-"].concat(
      args.flatMap((arg) => arg.build(config, document, formattingOptions))
    );
    const cwd = vscode.Uri.joinPath(document.uri, "..");
    const childOptions = { cwd: cwd.fsPath };
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

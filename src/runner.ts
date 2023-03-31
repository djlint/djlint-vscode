import { spawn } from "child_process";
import * as vscode from "vscode";
import { getErrorMsg } from "./errorHandler";

export function runDjlint(
  document: vscode.TextDocument,
  pythonExec: string,
  args: string[]
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const childArgs = ["-m", "djlint", "-"].concat(args);
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

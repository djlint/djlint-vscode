import * as vscode from "vscode";

export function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("djlint");
}

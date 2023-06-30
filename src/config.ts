import vscode from "vscode";

export const configSection = "djlint";

export function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(configSection);
}

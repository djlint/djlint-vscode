import vscode from "vscode";

export const configSection = "djlint";

export function getConfig(
  scope?: vscode.ConfigurationScope
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(configSection, scope);
}

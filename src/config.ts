import * as vscode from "vscode";

export const configSection = "djlint";

// Written into settings.json when these were the defaults, they mean "on PATH", which comes after the active environment.
const OLD_DEFAULTS = { executablePath: "djlint", pythonPath: "python" };

export function getConfiguredPath(
  config: vscode.WorkspaceConfiguration,
  key: keyof typeof OLD_DEFAULTS,
): string {
  const value = config.get<string>(key)?.trim() ?? "";
  return value === OLD_DEFAULTS[key] ? "" : value;
}

export function getConfig(
  scope?: vscode.ConfigurationScope,
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(configSection, scope);
}

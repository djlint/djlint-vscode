import path from "node:path";
import * as vscode from "vscode";

export function workspaceScopeKey(document: vscode.TextDocument): string {
  return (
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? ""
  );
}

function resolveAgainstWorkspaceRoot(
  value: string,
  document: vscode.TextDocument,
): string {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  return folder?.uri.scheme === "file"
    ? path.resolve(folder.uri.fsPath, value)
    : value;
}

function isWrittenAsPath(value: string): boolean {
  return /[\\/]/u.test(value);
}

export function normalizeConfiguredExecutable(
  raw: string,
  document: vscode.TextDocument,
): string {
  const exec = raw.trim();
  return exec && isWrittenAsPath(exec) && !path.isAbsolute(exec)
    ? resolveAgainstWorkspaceRoot(exec, document)
    : exec;
}

export function resolveWorkspaceFilePath(
  value: string,
  document: vscode.TextDocument,
): string {
  return value && !path.isAbsolute(value)
    ? resolveAgainstWorkspaceRoot(value, document)
    : value;
}

import path from "node:path";
import * as vscode from "vscode";

const NO_FILENAME = "-";

export function workspaceScopeKey(document: vscode.TextDocument): string {
  return (
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? ""
  );
}

export function directoryScopeKey(document: vscode.TextDocument): string {
  const uri = document.uri.toString();
  return uri.slice(0, uri.lastIndexOf("/") + 1) || uri;
}

export function isVirtualDocument(document: vscode.TextDocument): boolean {
  return (
    document.uri.scheme !== "file" &&
    (document.uri.scheme === "vscode-vfs" ||
      vscode.workspace.getWorkspaceFolder(document.uri) != null)
  );
}

export function isSupportedDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" || isVirtualDocument(document);
}

export function deriveStdinFilename(document: vscode.TextDocument): string {
  if (!isSupportedDocument(document)) {
    return NO_FILENAME;
  }
  const relativePath = vscode.workspace.asRelativePath(document.uri, false);
  return relativePath ? relativePath.replaceAll("\\", "/") : NO_FILENAME;
}

function resolveAgainstWorkspaceRoot(
  value: string,
  document: vscode.TextDocument,
): string {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  return folder?.uri.scheme === "file"
    ? vscode.Uri.joinPath(folder.uri, value).fsPath
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

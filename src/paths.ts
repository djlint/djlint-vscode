import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

export const supportedUriSchemes: ReadonlySet<string> = new Set([
  "file",
  "vscode-vfs",
]);

const NO_FILENAME = "-";

export function workspaceScopeKey(document: vscode.TextDocument): string {
  return (
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? ""
  );
}

export function getDocumentFolder(
  document: vscode.TextDocument,
): string | undefined {
  if (document.uri.scheme !== "file") {
    return void 0;
  }
  const folder = vscode.Uri.joinPath(document.uri, "..").fsPath;
  return existsSync(folder) ? folder : void 0;
}

export function deriveStdinFilename(document: vscode.TextDocument): string {
  if (!supportedUriSchemes.has(document.uri.scheme)) {
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

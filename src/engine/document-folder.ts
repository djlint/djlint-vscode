import { existsSync } from "node:fs";
import * as vscode from "vscode";

export function getDocumentFolder(
  document: vscode.TextDocument,
): string | undefined {
  if (document.uri.scheme !== "file") {
    return void 0;
  }
  const folder = vscode.Uri.joinPath(document.uri, "..").fsPath;
  return existsSync(folder) ? folder : void 0;
}

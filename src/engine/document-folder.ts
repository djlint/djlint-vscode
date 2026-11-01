import { stat } from "node:fs/promises";
import * as vscode from "vscode";

export function getDocumentFolder(document: vscode.TextDocument): string | undefined {
  return document.uri.scheme === "file" ? vscode.Uri.joinPath(document.uri, "..").fsPath : void 0;
}

// A spawn from a folder that is gone fails like a missing executable.
export async function getExistingDocumentFolder(
  document: vscode.TextDocument,
): Promise<string | undefined> {
  const folder = getDocumentFolder(document);
  if (folder == null) {
    return void 0;
  }
  try {
    await stat(folder);
    return folder;
  } catch {
    return void 0;
  }
}

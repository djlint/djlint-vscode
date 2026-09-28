import * as vscode from "vscode";
import { supportedUriSchemes } from "./schemes.js";

const NO_FILENAME = "-";

export function deriveStdinFilenameFromParts(
  scheme: string,
  relativePath: string | undefined,
  fsPath: string | undefined,
): string {
  if (!supportedUriSchemes.has(scheme)) {
    return NO_FILENAME;
  }
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a document outside every workspace folder has an empty relative path, which must fall through to fsPath
  const raw = relativePath || fsPath;
  return raw ? raw.replaceAll("\\", "/") : NO_FILENAME;
}

export function deriveStdinFilename(document: vscode.TextDocument): string {
  return deriveStdinFilenameFromParts(
    document.uri.scheme,
    vscode.workspace.asRelativePath(document.uri, false),
    document.uri.fsPath,
  );
}

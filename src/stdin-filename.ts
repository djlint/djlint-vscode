import * as vscode from "vscode";

// Mirrors linter.ts's `supportedUriSchemes` (kept as a local copy to avoid a dependency back up to linter.ts).
const supportedFilenameSchemes: ReadonlySet<string> = new Set([
  "file",
  "vscode-vfs",
]);

/** Derives the path djLint should match `per-file-ignores` patterns against:
the document's workspace-relative path when known, falling back to the
absolute filesystem path, falling back to `"-"` for untitled/unsupported
schemes. Backslashes are normalized to forward slashes, since those patterns
are written with `/`. */
export function deriveStdinFilenameFromParts(
  scheme: string,
  relativePath: string | undefined,
  fsPath: string | undefined,
): string {
  if (!supportedFilenameSchemes.has(scheme)) {
    return "-";
  }
  // An empty relative path (no containing workspace folder) is treated as absent: `||`, not `??`, is intentional.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const raw = relativePath || fsPath;
  return raw ? raw.replaceAll("\\", "/") : "-";
}

/** `deriveStdinFilenameFromParts()`, sourcing its inputs from a live
`vscode.TextDocument`. Shared by the Pyodide engine and `StdinFilenameArg`
so both match `per-file-ignores` against the same filename. */
export function deriveStdinFilename(document: vscode.TextDocument): string {
  return deriveStdinFilenameFromParts(
    document.uri.scheme,
    vscode.workspace.asRelativePath(document.uri, false),
    document.uri.fsPath,
  );
}

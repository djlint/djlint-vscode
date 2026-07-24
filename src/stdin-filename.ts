import * as vscode from "vscode";

// Mirrors linter.ts's `supportedUriSchemes`: the schemes for which a document has a meaningful, stable path. Kept as a local copy rather than a shared import to avoid a dependency from this shared module back up to linter.ts.
const supportedFilenameSchemes: ReadonlySet<string> = new Set([
  "file",
  "vscode-vfs",
]);

/** Derives the path djLint should match `per-file-ignores` patterns against
(the `--stdin-filename` CLI value on the subprocess path, the `linter()` /
`formatter()` `filepath` argument on the Pyodide path): the document's
workspace-relative path when known (the form users write those patterns
against), falling back to the absolute filesystem path, falling back to
`"-"` for untitled/unsupported schemes. Backslashes are normalized to
forward slashes, since per-file-ignores patterns are written with `/`. Pure
(plain strings in, string out) so it is unit-testable outside VS Code. */
export function deriveStdinFilenameFromParts(
  scheme: string,
  relativePath: string | undefined,
  fsPath: string | undefined,
): string {
  if (!supportedFilenameSchemes.has(scheme)) {
    return "-";
  }
  // An empty relative path (e.g. when asRelativePath finds no containing workspace folder) is treated the same as "absent": `||`, not `??`, is intentional here.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const raw = relativePath || fsPath;
  return raw ? raw.replaceAll("\\", "/") : "-";
}

/** `deriveStdinFilenameFromParts()`, sourcing its inputs from a live
`vscode.TextDocument`. Shared by the Pyodide engine (`per_file_ignores`
matching in-process) and `StdinFilenameArg` (`--stdin-filename` on the
subprocess path), so both engines match `per-file-ignores` patterns against
the exact same filename for a given document. */
export function deriveStdinFilename(document: vscode.TextDocument): string {
  return deriveStdinFilenameFromParts(
    document.uri.scheme,
    vscode.workspace.asRelativePath(document.uri, false),
    document.uri.fsPath,
  );
}

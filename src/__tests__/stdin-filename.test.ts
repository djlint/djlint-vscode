import { expect, test, vi } from "vitest";

// deriveStdinFilenameFromParts() never touches vscode, so an empty stub is
// enough to let the module load (deriveStdinFilename(), which does call
// vscode.workspace.asRelativePath, is exercised via the Pyodide engine and
// SubprocessEngine integration paths instead).
vi.mock("vscode", () => ({}));

const { deriveStdinFilenameFromParts } = await import("../stdin-filename.js");

test("prefers the workspace-relative path over the filesystem path", () => {
  expect(
    deriveStdinFilenameFromParts(
      "file",
      "templates/index.html",
      "/home/user/project/templates/index.html",
    ),
  ).toBe("templates/index.html");
});

test("falls back to the filesystem path when there is no relative path", () => {
  expect(
    deriveStdinFilenameFromParts(
      "file",
      void 0,
      "/home/user/project/index.html",
    ),
  ).toBe("/home/user/project/index.html");
});

test("treats an empty relative path as absent and falls back to fsPath", () => {
  expect(
    deriveStdinFilenameFromParts("file", "", "/home/user/project/index.html"),
  ).toBe("/home/user/project/index.html");
});

test("falls back to the '-' placeholder for untitled documents, ignoring any paths given", () => {
  expect(
    deriveStdinFilenameFromParts("untitled", "Untitled-1", "Untitled-1"),
  ).toBe("-");
});

test("falls back to the '-' placeholder for unsupported schemes", () => {
  expect(
    deriveStdinFilenameFromParts(
      "http",
      "index.html",
      "https://example.com/index.html",
    ),
  ).toBe("-");
});

test("falls back to the '-' placeholder when neither path is available", () => {
  expect(deriveStdinFilenameFromParts("file", void 0, void 0)).toBe("-");
});

test("supports the vscode-vfs scheme (virtual/remote workspaces)", () => {
  expect(
    deriveStdinFilenameFromParts("vscode-vfs", "templates/index.html", void 0),
  ).toBe("templates/index.html");
});

test("normalizes Windows backslashes to forward slashes in the relative path", () => {
  expect(
    deriveStdinFilenameFromParts(
      "file",
      String.raw`templates\index.html`,
      String.raw`C:\project\templates\index.html`,
    ),
  ).toBe("templates/index.html");
});

test("normalizes Windows backslashes to forward slashes in the fsPath fallback", () => {
  expect(
    deriveStdinFilenameFromParts(
      "file",
      void 0,
      String.raw`C:\project\templates\index.html`,
    ),
  ).toBe("C:/project/templates/index.html");
});

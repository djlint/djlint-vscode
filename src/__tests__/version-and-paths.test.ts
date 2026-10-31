// Edge-case sweep over the pure helpers, checking each against what the
// callers actually require of them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  getDocumentFolder,
  getExistingDocumentFolder,
} from "../engine/document-folder.js";
import { parseLinterOutput } from "../engine/subprocess/parse-lint-output.js";
import {
  isVersionAtLeast,
  parseDjlintVersion,
} from "../engine/subprocess/version.js";
import { deriveStdinFilename, workspaceScopeKey } from "../paths.js";
import { makeDocument, setWorkspaceFolders } from "./helpers.js";
import { control, resetVscode, Uri } from "./vscode-stub.js";

const FS = "\u{1F}";
const RS = "\u{1E}";

beforeEach(() => {
  resetVscode();
  vi.restoreAllMocks();
});

describe("parseLinterOutput, pinned format", () => {
  it("reads the end of a finding", () => {
    expect(
      parseLinterOutput(`H025${FS}3:7${FS}m${FS}4:2${RS}\n`),
    ).toStrictEqual([
      {
        code: "H025",
        column: 7,
        endColumn: 2,
        endLine: 4,
        line: 3,
        message: "m",
      },
    ]);
  });

  it("does not take a message for an end when there is none", () => {
    expect(parseLinterOutput(`H025${FS}3:7${FS}4:2${RS}\n`)).toStrictEqual([
      { code: "H025", column: 7, line: 3, message: "4:2" },
    ]);
  });

  it("leaves out an end before the start", () => {
    expect(
      parseLinterOutput(`H025${FS}3:7${FS}m${FS}3:1${RS}\n`),
    ).toStrictEqual([{ code: "H025", column: 7, line: 3, message: "m" }]);
  });

  it("keeps a colon in the message", () => {
    expect(
      parseLinterOutput(
        `H025${FS}3:7${FS}Tag seems to be orphan: <div>${RS}\n`,
      ),
    ).toStrictEqual([
      {
        code: "H025",
        column: 7,
        line: 3,
        message: "Tag seems to be orphan: <div>",
      },
    ]);
  });

  it("keeps a newline in the message", () => {
    expect(
      parseLinterOutput(`H025${FS}3:7${FS}line one\nline two${RS}\n`),
    ).toStrictEqual([
      { code: "H025", column: 7, line: 3, message: "line one\nline two" },
    ]);
  });

  it("reads multiple records", () => {
    expect(
      parseLinterOutput(`A1${FS}1:0${FS}m1${RS}\nB2${FS}2:3${FS}m2${RS}\n`),
    ).toStrictEqual([
      { code: "A1", column: 0, line: 1, message: "m1" },
      { code: "B2", column: 3, line: 2, message: "m2" },
    ]);
  });

  it("treats empty and whitespace-only stdout as no findings", () => {
    expect(parseLinterOutput("")).toStrictEqual([]);
    expect(parseLinterOutput("\r\n  \n")).toStrictEqual([]);
  });

  it("ignores the summary after the last record (no --quiet)", () => {
    expect(
      parseLinterOutput(
        `H013${FS}1:5${FS}msg${RS}\r\nLinted 1 file, found 1 error.\r\n`,
      ),
    ).toStrictEqual([{ code: "H013", column: 5, line: 1, message: "msg" }]);
  });

  it.each([
    ["an empty line field", `H1${FS}:5${FS}m${RS}\n`],
    ["a non-numeric line", `H1${FS}x:5${FS}m${RS}\n`],
  ])("drops a record with %s", (_label, stdout) => {
    expect(parseLinterOutput(stdout)).toStrictEqual([]);
  });

  it("does not lose the good records to a bad one", () => {
    expect(
      parseLinterOutput(`H1${FS}x:5${FS}bad${RS}\nH2${FS}4:1${FS}good${RS}\n`),
    ).toStrictEqual([{ code: "H2", column: 1, line: 4, message: "good" }]);
  });

  it("moves line 0 to the first line", () => {
    expect(parseLinterOutput(`H1${FS}0:5${FS}m${RS}\n`)).toStrictEqual([
      { code: "H1", column: 5, line: 1, message: "m" },
    ]);
  });

  it("moves the end on line 0 with it", () => {
    expect(parseLinterOutput(`H1${FS}0:5${FS}m${FS}0:9${RS}\n`)).toStrictEqual([
      {
        code: "H1",
        column: 5,
        endColumn: 9,
        endLine: 1,
        line: 1,
        message: "m",
      },
    ]);
  });
});

describe("parseLinterOutput, legacy format", () => {
  it("reads a single finding", () => {
    expect(
      parseLinterOutput("H013 1:5 Img tag should have an alt attribute. <img>"),
    ).toStrictEqual([
      {
        code: "H013",
        column: 5,
        line: 1,
        message: "Img tag should have an alt attribute. <img>",
      },
    ]);
  });

  it("moves line 0 to the first line", () => {
    expect(parseLinterOutput("H013 0:5 msg")).toStrictEqual([
      { code: "H013", column: 5, line: 1, message: "msg" },
    ]);
  });

  it("reads several findings", () => {
    expect(parseLinterOutput("H013 1:5 first\nH014 2:6 second")).toStrictEqual([
      { code: "H013", column: 5, line: 1, message: "first" },
      { code: "H014", column: 6, line: 2, message: "second" },
    ]);
  });

  it("does not leak the /g regex's lastIndex between calls", () => {
    expect(parseLinterOutput("H013 1:5 x")).toStrictEqual(
      parseLinterOutput("H013 1:5 x"),
    );
  });
});

describe("deriveStdinFilename", () => {
  it("is the path relative to the workspace", () => {
    setWorkspaceFolders("/w");
    expect(deriveStdinFilename(makeDocument("/w/a/b.html"))).toBe("a/b.html");
  });

  it("normalizes backslashes", () => {
    vi.spyOn(vscode.workspace, "asRelativePath").mockReturnValue("a\\b.html");
    expect(deriveStdinFilename(makeDocument("/w/a/b.html"))).toBe("a/b.html");
  });

  it("uses the full path outside any workspace folder", () => {
    const document = makeDocument("/w/b.html");
    expect(deriveStdinFilename(document)).toBe(
      document.uri.fsPath.replaceAll("\\", "/"),
    );
  });

  it("is `-` for an unsupported scheme", () => {
    expect(
      deriveStdinFilename(makeDocument(vscode.Uri.parse("untitled:a.html"))),
    ).toBe("-");
  });

  it("supports vscode-vfs", () => {
    control.workspaceFolders = [{ uri: Uri.parse("vscode-vfs://github/o/r") }];
    expect(
      deriveStdinFilename(
        makeDocument(vscode.Uri.parse("vscode-vfs://github/o/r/a.html")),
      ),
    ).toBe("a.html");
  });

  it("is `-` when nothing usable is left", () => {
    vi.spyOn(vscode.workspace, "asRelativePath").mockReturnValue("");
    expect(deriveStdinFilename(makeDocument("/w/b.html"))).toBe("-");
  });
});

describe("parseDjlintVersion", () => {
  it("takes the last version, past what a wrapper printed", () => {
    expect(
      parseDjlintVersion(
        "mise version 0.4.1 activated\ndjlint, version 1.47.1",
      ),
    ).toBe("1.47.1");
  });
});

describe("document location helpers", () => {
  it("finds the folder of a file", () => {
    expect(getDocumentFolder(makeDocument("/w/a/b.html"))).toBe(
      vscode.Uri.file("/w/a").fsPath,
    );
  });

  it("finds no existing folder for a file whose folder is gone", async () => {
    await expect(
      getExistingDocumentFolder(makeDocument("/no/such/folder/b.html")),
    ).resolves.toBeUndefined();
  });

  it("has no folder for a document that is not a local file", () => {
    expect(
      getDocumentFolder(
        makeDocument(vscode.Uri.parse("vscode-vfs://github/o/r/a.html")),
      ),
    ).toBeUndefined();
  });

  it("scopes by workspace folder", () => {
    setWorkspaceFolders("/one", "/two");
    const one = workspaceScopeKey(makeDocument("/one/a/b.html"));
    expect(one).toBe(workspaceScopeKey(makeDocument("/one/c.html")));
    expect(one).not.toBe(workspaceScopeKey(makeDocument("/two/c.html")));
    expect(workspaceScopeKey(makeDocument("/loose/c.html"))).toBe("");
  });
});

describe("parseDjlintVersion", () => {
  it.each([
    ["djlint, version 1.44.2", "1.44.2"],
    ["djlint, version 1.44", "1.44"],
    ["not a version", null],
    ["Python 3.12.1", null],
  ])("reads %j", (stdout, expected) => {
    expect(parseDjlintVersion(stdout)).toBe(expected);
  });
});

describe("isVersionAtLeast", () => {
  it.each([
    ["1.5", "1.25", false],
    ["1.25", "1.25", true],
    ["1.43", "1.43.0", true],
    ["1.43.0", "1.43", true],
    ["1.30.1", "1.30.2", false],
    ["2.0", "1.44", true],
    ["1.9", "1.13", false],
  ])("%s >= %s is %j", (version, required, expected) => {
    expect(isVersionAtLeast(version, required)).toBe(expected);
  });
});

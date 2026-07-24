import { expect, test, vi } from "vitest";
import { buildConfigKwargs } from "../kwargs.js";

// kwargs.ts pulls in args.ts, which (via StdinFilenameArg) now imports the
// shared stdin-filename.ts module, which imports "vscode" (not resolvable
// outside a real extension host) for `deriveStdinFilename()`'s
// `vscode.workspace.asRelativePath()` call. That call is never reached from
// this file (buildConfigKwargs() only exercises `buildKwarg()`, and
// StdinFilenameArg.buildKwarg() is CLI-only — it returns `undefined` without
// touching `document`), so an empty stub is enough to satisfy module
// resolution.
vi.mock("vscode", () => ({}));

function fakeConfig(values: Record<string, unknown>): any {
  return { get: (k: string): unknown => values[k] };
}

const fakeDocument: any = {};

test("maps format settings to Config kwargs", () => {
  const cfg = fakeConfig({
    profile: "django",
    formatCss: true,
    maxLineLength: 120,
    useEditorIndentation: true,
  });
  const formattingOptions: any = { tabSize: 4, insertSpaces: true };
  const kwargs = buildConfigKwargs(
    cfg,
    fakeDocument,
    formattingOptions,
    "format",
  );
  expect(kwargs["profile"]).toBe("django");
  expect(kwargs["format_css"]).toBe(true);
  expect(kwargs["max_line_length"]).toBe(120);
  expect(kwargs["indent"]).toBe(4);
  expect(kwargs).not.toHaveProperty("reformat");
});

test("omits empty/absent values", () => {
  const cfg = fakeConfig({ profile: "" });
  const formattingOptions: any = { tabSize: 2 };
  const kwargs = buildConfigKwargs(
    cfg,
    fakeDocument,
    formattingOptions,
    "lint",
  );
  expect(kwargs).not.toHaveProperty("profile");
});

test("joins array options into comma strings", () => {
  const cfg = fakeConfig({ ignore: ["H001", "H002"] });
  const formattingOptions: any = { tabSize: 2 };
  const kwargs = buildConfigKwargs(
    cfg,
    fakeDocument,
    formattingOptions,
    "lint",
  );
  expect(kwargs["ignore"]).toBe("H001,H002");
});

test("format mode never emits the CLI-only reformat kwarg", () => {
  const cfg = fakeConfig({});
  const formattingOptions: any = { tabSize: 2 };
  const kwargs = buildConfigKwargs(
    cfg,
    fakeDocument,
    formattingOptions,
    "format",
  );
  expect(kwargs).not.toHaveProperty("reformat");
});

test("lint mode never emits the CLI-only linter_output_format or quiet kwargs", () => {
  const cfg = fakeConfig({ useNewLinterOutputParser: true });
  const kwargs = buildConfigKwargs(cfg, fakeDocument, void 0, "lint");
  expect(kwargs).not.toHaveProperty("linter_output_format");
  expect(kwargs).not.toHaveProperty("quiet");
});

// Regression coverage for Finding B: configuration/rules are host filesystem
// paths the bundled Pyodide runtime cannot resolve (it has no access to the
// host filesystem); djLint's Config raised an uncaught FileNotFoundError for
// a missing path, silently breaking format/lint. buildConfigKwargs() must
// never forward either, even when set -- the subprocess (CLI) path is
// unaffected since it uses CliArg.build(), not buildKwarg().
test("never emits configuration/rules kwargs, even when set (bundled runtime has no host filesystem access)", () => {
  const cfg = fakeConfig({
    configuration: "/workspace/.djlintrc",
    rules: "/workspace/rules.yaml",
  });
  const formattingOptions: any = { tabSize: 2 };

  const formatKwargs = buildConfigKwargs(
    cfg,
    fakeDocument,
    formattingOptions,
    "format",
  );
  const lintKwargs = buildConfigKwargs(
    cfg,
    fakeDocument,
    formattingOptions,
    "lint",
  );

  expect(formatKwargs).not.toHaveProperty("configuration");
  expect(formatKwargs).not.toHaveProperty("rules");
  expect(lintKwargs).not.toHaveProperty("configuration");
  expect(lintKwargs).not.toHaveProperty("rules");
});

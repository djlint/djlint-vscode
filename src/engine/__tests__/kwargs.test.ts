import { expect, test } from "vitest";
import { buildConfigKwargs } from "../kwargs.js";

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

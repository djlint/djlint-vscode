import { expect, test } from "vitest";
import { parseLinterOutput } from "../parse-lint-output.js";

test("parses the new (templated) output format", () => {
  const stdout =
    "<filename>-</filename><line>12:3</line><code>H025</code><message>Tag seems to be an orphan</message>\n";
  expect(parseLinterOutput(stdout, true)).toEqual([
    { line: 12, column: 3, code: "H025", message: "Tag seems to be an orphan" },
  ]);
});

test("parses the legacy output format", () => {
  const stdout = "H025   12:3   Tag seems to be an orphan\n";
  expect(parseLinterOutput(stdout, false)).toEqual([
    { line: 12, column: 3, code: "H025", message: "Tag seems to be an orphan" },
  ]);
});

test("returns [] for empty output", () => {
  expect(parseLinterOutput("", true)).toEqual([]);
});

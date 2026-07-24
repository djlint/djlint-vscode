import { expect, test } from "vitest";
import type { CustomExecaError } from "../../../runner.js";
import { isDjlintUnavailable } from "../unavailable.js";

function execaError(over: Partial<CustomExecaError> = {}): CustomExecaError {
  const e: any = { code: void 0, stderr: "", ...over };
  return e;
}

test("matches CPython's quoted ModuleNotFoundError message", () => {
  expect(
    isDjlintUnavailable(execaError({ stderr: "No module named 'djlint'" })),
  ).toBe(true);
});

test("matches an unquoted 'No module named djlint' message", () => {
  expect(
    isDjlintUnavailable(execaError({ stderr: "No module named djlint" })),
  ).toBe(true);
});

test("matches ENOENT regardless of stderr", () => {
  expect(
    isDjlintUnavailable(execaError({ code: "ENOENT", stderr: "unrelated" })),
  ).toBe(true);
});

test("does not match unrelated stderr", () => {
  expect(
    isDjlintUnavailable(execaError({ stderr: "SyntaxError: invalid syntax" })),
  ).toBe(false);
});

test("does not match djlint_extras (a djlint-prefixed submodule)", () => {
  expect(
    isDjlintUnavailable(
      execaError({ stderr: "No module named 'djlint_extras'" }),
    ),
  ).toBe(false);
});

test("does not match djlint.rules.foo (a djlint subpackage)", () => {
  expect(
    isDjlintUnavailable(
      execaError({ stderr: "No module named 'djlint.rules.foo'" }),
    ),
  ).toBe(false);
});

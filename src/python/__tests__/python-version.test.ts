import { expect, test } from "vitest";
import { parsePythonVersion } from "../python-version.js";

test("parses major.minor.patch", () => {
  expect(parsePythonVersion("3.13.1")).toStrictEqual({
    major: 3,
    minor: 13,
    patch: 1,
  });
});

test("parses major.minor without a patch", () => {
  expect(parsePythonVersion("3.13")).toStrictEqual({
    major: 3,
    minor: 13,
    patch: null,
  });
});

test("ignores trailing non-numeric release info", () => {
  expect(parsePythonVersion("3.13.1rc1")).toStrictEqual({
    major: 3,
    minor: 13,
    patch: 1,
  });
  expect(parsePythonVersion("3.13rc1")).toStrictEqual({
    major: 3,
    minor: 13,
    patch: null,
  });
});

test("returns null when major is missing", () => {
  expect(parsePythonVersion("")).toBeNull();
  expect(parsePythonVersion("abc")).toBeNull();
});

test("returns null when minor is missing", () => {
  expect(parsePythonVersion("3")).toBeNull();
});

test("treats a leading zero-padded component as decimal", () => {
  expect(parsePythonVersion("3.09.05")).toStrictEqual({
    major: 3,
    minor: 9,
    patch: 5,
  });
});

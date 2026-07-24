import { expect, test } from "vitest";
import { isVersionAtLeast, parseDjlintVersion } from "../version.js";

test("parseDjlintVersion: parses djLint's '--version' output", () => {
  expect(parseDjlintVersion("djlint, version 1.42.3\n")).toBe("1.42.3");
});

test("parseDjlintVersion: parses a two-component version", () => {
  expect(parseDjlintVersion("djlint, version 1.42\n")).toBe("1.42");
});

test("parseDjlintVersion: is not anchored to a specific prefix (also matches '<python> -m djlint --version' output)", () => {
  expect(parseDjlintVersion("djlint, version 0.5.8")).toBe("0.5.8");
});

test("parseDjlintVersion: returns null for unrecognized output", () => {
  expect(parseDjlintVersion("command not found: djlint")).toBeNull();
  expect(parseDjlintVersion("")).toBeNull();
});

test("isVersionAtLeast: equal versions", () => {
  expect(isVersionAtLeast("1.42.3", "1.42.3")).toBe(true);
});

test("isVersionAtLeast: greater version", () => {
  expect(isVersionAtLeast("1.43.0", "1.42.3")).toBe(true);
});

test("isVersionAtLeast: fewer version", () => {
  expect(isVersionAtLeast("1.42.3", "1.43.0")).toBe(false);
});

test("isVersionAtLeast: version has fewer components than minVersion ('1.42' vs '1.42.0')", () => {
  expect(isVersionAtLeast("1.42", "1.42.0")).toBe(true);
});

test("isVersionAtLeast: minVersion has fewer components than version ('1.42.0' vs '1.42')", () => {
  expect(isVersionAtLeast("1.42.0", "1.42")).toBe(true);
});

test("isVersionAtLeast: missing patch component still loses to a required nonzero patch", () => {
  expect(isVersionAtLeast("1.42", "1.42.1")).toBe(false);
});

test("isVersionAtLeast: numeric, not lexicographic, comparison ('1.5' vs '1.25')", () => {
  expect(isVersionAtLeast("1.5", "1.25")).toBe(false);
  expect(isVersionAtLeast("1.25", "1.5")).toBe(true);
});

test("isVersionAtLeast: an earlier component decides regardless of later components", () => {
  expect(isVersionAtLeast("2.0.0", "1.99.99")).toBe(true);
  expect(isVersionAtLeast("1.99.99", "2.0.0")).toBe(false);
});

test("isVersionAtLeast: single-component versions", () => {
  expect(isVersionAtLeast("2", "1")).toBe(true);
  expect(isVersionAtLeast("1", "2")).toBe(false);
  expect(isVersionAtLeast("1", "1")).toBe(true);
});

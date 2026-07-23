import { expect, test, vi } from "vitest";

/*
 * The untouched getEngine() in select.ts pulls in SubprocessEngine ->
 * runner.ts -> the "vscode" module, which isn't available outside VS Code.
 * Stub that one hop so this file can exercise the pure selectEngine() in
 * isolation, with no dependency on VS Code at all.
 */
vi.mock("../subprocess/index.js", () => ({}));

const { selectEngine } = await import("../select.js");

interface FakeEngine {
  kind: "sub" | "pyo";
}

function deps(
  over: Partial<{
    importStrategy: "fromEnvironment" | "useBundled";
    isTrusted: boolean;
  }> = {},
): {
  importStrategy: "fromEnvironment" | "useBundled";
  isTrusted: boolean;
  makeSubprocess: () => FakeEngine;
  makePyodide: () => FakeEngine;
} {
  return {
    importStrategy: "fromEnvironment",
    isTrusted: true,
    makeSubprocess: vi.fn((): FakeEngine => ({ kind: "sub" })),
    makePyodide: vi.fn((): FakeEngine => ({ kind: "pyo" })),
    ...over,
  };
}

test("useBundled → pyodide", () => {
  expect(selectEngine(deps({ importStrategy: "useBundled" })).kind).toBe("pyo");
});

test("untrusted → pyodide", () => {
  expect(selectEngine(deps({ isTrusted: false })).kind).toBe("pyo");
});

test("fromEnvironment trusted → subprocess (fallback handled at call time)", () => {
  expect(selectEngine(deps()).kind).toBe("sub");
});

test("untrusted + useBundled → pyodide (both conditions)", () => {
  expect(
    selectEngine(deps({ importStrategy: "useBundled", isTrusted: false })).kind,
  ).toBe("pyo");
});

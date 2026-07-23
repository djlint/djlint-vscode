import { expect, test, vi } from "vitest";
import type { EngineSelectionDeps } from "../select.js";

/*
 * getEngine() in select.ts pulls in the two engines + config + the "vscode"
 * module, none of which resolve outside VS Code. Stub those hops so this file
 * can exercise the pure selectEngine() in isolation.
 */
vi.mock("vscode", () => ({}));
vi.mock("../subprocess/index.js", () => ({}));
vi.mock("../pyodide/index.js", () => ({}));
vi.mock("../../config.js", () => ({}));

const { selectEngine } = await import("../select.js");

interface FakeEngine {
  kind: "sub" | "pyo";
}

function deps(
  over: Partial<
    Pick<EngineSelectionDeps<FakeEngine>, "importStrategy" | "isTrusted">
  > = {},
): EngineSelectionDeps<FakeEngine> {
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

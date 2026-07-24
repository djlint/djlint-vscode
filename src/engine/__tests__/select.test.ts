import { expect, test, vi } from "vitest";
import type { EngineSelectionDeps } from "../select.js";
import { DjlintUnavailableError } from "../types.js";

/*
 * getEngine() in select.ts pulls in the two engines + config + the "vscode"
 * module, none of which resolve outside VS Code. Stub those hops so this file
 * can exercise the pure selectEngine() in isolation.
 */
vi.mock("vscode", () => ({}));
vi.mock("../subprocess/index.js", () => ({}));
vi.mock("../pyodide/index.js", () => ({}));
vi.mock("../../config.js", () => ({}));

const { selectEngine, FallbackEngine } = await import("../select.js");

interface FakeEngine {
  kind: "sub" | "pyo";
}

function deps(
  over: Partial<Pick<EngineSelectionDeps<FakeEngine>, "isTrusted">> = {},
): EngineSelectionDeps<FakeEngine> {
  return {
    isTrusted: true,
    makeSubprocess: vi.fn((): FakeEngine => ({ kind: "sub" })),
    makePyodide: vi.fn((): FakeEngine => ({ kind: "pyo" })),
    ...over,
  };
}

test("trusted → subprocess (bundled fallback handled at call time via FallbackEngine)", () => {
  expect(selectEngine(deps()).kind).toBe("sub");
});

test("untrusted → pyodide", () => {
  expect(selectEngine(deps({ isTrusted: false })).kind).toBe("pyo");
});

test("untrusted never calls makeSubprocess (never execute env tools on untrusted content)", () => {
  const d = deps({ isTrusted: false });
  selectEngine(d);
  expect(d.makeSubprocess).not.toHaveBeenCalled();
});

test("trusted never calls makePyodide directly (selection, not the fallback path)", () => {
  const d = deps();
  selectEngine(d);
  expect(d.makePyodide).not.toHaveBeenCalled();
});

const doc: any = {};
const config: any = {};
const fmtOpts: any = {};
const token: any = {};

function fakeEngine(over: any = {}): any {
  return {
    format: vi.fn(async () => "primary-format"),
    lint: vi.fn(async () => []),
    dispose: vi.fn(),
    ...over,
  };
}

test("FallbackEngine switches to secondary on DjlintUnavailableError, logs once, stays switched", async () => {
  const output: any = { info: vi.fn() };
  const primary = fakeEngine({
    format: vi.fn(async () => {
      throw new DjlintUnavailableError("no djlint");
    }),
  });
  const secondary = fakeEngine({
    format: vi.fn(async () => "secondary-format"),
  });
  const makeSecondary = vi.fn(() => secondary);
  const engine = new FallbackEngine(primary, makeSecondary, output);

  expect(await engine.format(doc, config, fmtOpts, token)).toBe(
    "secondary-format",
  );
  expect(output.info).toHaveBeenCalledTimes(1);

  // A second call goes straight to the secondary: primary is not retried and
  // the secondary is reused (created once).
  await engine.format(doc, config, fmtOpts, token);
  expect(primary.format).toHaveBeenCalledTimes(1);
  expect(makeSecondary).toHaveBeenCalledTimes(1);
});

test("FallbackEngine rethrows a non-DjlintUnavailableError without switching", async () => {
  const output: any = { info: vi.fn() };
  const boom = new Error("real failure");
  const primary = fakeEngine({
    format: vi.fn(async () => {
      throw boom;
    }),
  });
  const makeSecondary = vi.fn(() => fakeEngine());
  const engine = new FallbackEngine(primary, makeSecondary, output);

  await expect(engine.format(doc, config, fmtOpts, token)).rejects.toBe(boom);
  expect(makeSecondary).not.toHaveBeenCalled();
  expect(output.info).not.toHaveBeenCalled();
});

test("FallbackEngine.lint also switches to secondary on DjlintUnavailableError", async () => {
  const output: any = { info: vi.fn() };
  const primary = fakeEngine({
    lint: vi.fn(async () => {
      throw new DjlintUnavailableError("no djlint");
    }),
  });
  const diagnostics = [{ code: "H013", line: 1, column: 0, message: "m" }];
  const secondary = fakeEngine({ lint: vi.fn(async () => diagnostics) });
  const engine = new FallbackEngine(
    primary,
    vi.fn(() => secondary),
    output,
  );

  expect(await engine.lint(doc, config, token)).toEqual(diagnostics);
});

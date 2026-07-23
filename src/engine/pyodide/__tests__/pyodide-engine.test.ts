import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  FORMAT_EXPECTED,
  FORMAT_INPUT,
  LINT_EXPECTED,
  LINT_INPUT,
} from "../../__tests__/fixtures/basic.html.js";
import {
  buildWorker,
  fakeConfig,
  fakeDocument,
  fakeFormattingOptions,
  fakeToken,
} from "../../__tests__/pyodide-harness.js";
import { PyodideEngine } from "../index.js";

// `index.ts` imports the vscode module (for CancellationError); it does not
// exist in the vitest node env, so stub the only runtime symbol used.
vi.mock("vscode", () => ({ CancellationError: class extends Error {} }));

// Real Pyodide-in-Node integration/parity test. Requires the bundled runtime
// (`npm run assets`); skipped gracefully when the assets are absent.
const assetsDir = path.resolve("assets/pyodide");
const hasAssets = existsSync(path.join(assetsDir, "pyodide.mjs"));

describe.skipIf(!hasAssets)("PyodideEngine (real Pyodide in Node)", () => {
  let engine: PyodideEngine;

  beforeAll(async () => {
    engine = new PyodideEngine(await buildWorker(), assetsDir);
  }, 120_000);

  afterAll(() => {
    engine.dispose();
  });

  test("format matches golden djLint output", async () => {
    const out = await engine.format(
      fakeDocument(FORMAT_INPUT),
      fakeConfig("django"),
      fakeFormattingOptions,
      fakeToken,
    );
    expect(out).toBe(FORMAT_EXPECTED);
  }, 120_000);

  test("lint returns structured diagnostics", async () => {
    const diagnostics = await engine.lint(
      fakeDocument(LINT_INPUT),
      fakeConfig("django"),
      fakeToken,
    );
    expect(diagnostics).toEqual(LINT_EXPECTED);
  }, 120_000);
});

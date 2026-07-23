import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PyodideEngine } from "../pyodide/index.js";
import { PARITY_CASES } from "./fixtures/parity-cases.js";
import {
  buildWorker,
  fakeConfig,
  fakeDocument,
  fakeFormattingOptions,
  fakeToken,
} from "./pyodide-harness.js";

vi.mock("vscode", () => ({ CancellationError: class extends Error {} }));

const assetsDir = path.resolve("assets/pyodide");
const hasAssets = existsSync(path.join(assetsDir, "pyodide.mjs"));

describe.skipIf(!hasAssets)("PyodideEngine parity across profiles", () => {
  let engine: PyodideEngine;

  beforeAll(async () => {
    engine = new PyodideEngine(await buildWorker(), assetsDir);
  }, 120_000);

  afterAll(() => {
    engine.dispose();
  });

  test.each(PARITY_CASES)(
    "$name: format + lint match golden djLint output",
    async (parityCase) => {
      const formatted = await engine.format(
        fakeDocument(parityCase.input),
        fakeConfig(parityCase.profile),
        fakeFormattingOptions,
        fakeToken,
      );
      expect(formatted).toBe(parityCase.expectedFormat);

      const diagnostics = await engine.lint(
        fakeDocument(parityCase.input),
        fakeConfig(parityCase.profile),
        fakeToken,
      );
      expect(diagnostics).toEqual(parityCase.expectedLint);
    },
    120_000,
  );
});

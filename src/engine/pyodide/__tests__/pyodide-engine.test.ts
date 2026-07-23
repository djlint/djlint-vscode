import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  FORMAT_EXPECTED,
  FORMAT_INPUT,
  LINT_EXPECTED,
  LINT_INPUT,
} from "../../__tests__/fixtures/basic.html.js";
import { PyodideEngine } from "../index.js";

// `index.ts` imports the vscode module (for CancellationError); it does not
// exist in the vitest node env, so stub the only runtime symbol used.
vi.mock("vscode", () => ({ CancellationError: class extends Error {} }));

// Real Pyodide-in-Node integration/parity test. Requires the bundled runtime
// (`npm run assets`); skipped gracefully when the assets are absent.
const assetsDir = resolve("assets/pyodide");
const hasAssets = existsSync(join(assetsDir, "pyodide.mjs"));

const doc = (text: string): any => ({ getText: () => text });
const config: any = {
  get: (key: string) => (key === "profile" ? "django" : undefined),
};
const fmtOptions: any = { tabSize: 4, insertSpaces: true };
const token: any = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
};

describe.skipIf(!hasAssets)("PyodideEngine (real Pyodide in Node)", () => {
  let engine: PyodideEngine;

  beforeAll(async () => {
    const workerPath = join(
      mkdtempSync(join(tmpdir(), "djlint-worker-")),
      "worker.cjs",
    );
    await esbuild.build({
      entryPoints: ["src/engine/pyodide/worker.ts"],
      bundle: true,
      outfile: workerPath,
      format: "cjs",
      platform: "node",
      target: "node22",
      external: ["vscode"],
    });
    engine = new PyodideEngine(workerPath, assetsDir);
  }, 120_000);

  afterAll(() => {
    engine.dispose();
  });

  test("format matches golden djLint output", async () => {
    const out = await engine.format(
      doc(FORMAT_INPUT),
      config,
      fmtOptions,
      token,
    );
    expect(out).toBe(FORMAT_EXPECTED);
  }, 120_000);

  test("lint returns structured diagnostics", async () => {
    const diagnostics = await engine.lint(doc(LINT_INPUT), config, token);
    expect(diagnostics).toEqual(LINT_EXPECTED);
  }, 120_000);
});

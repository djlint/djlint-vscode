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
  fakeOutputChannel,
  fakeToken,
} from "../../__tests__/pyodide-harness.js";
import { PyodideEngine } from "../index.js";

// `index.ts` imports the vscode module (for CancellationError and
// workspace.asRelativePath); it does not exist in the vitest node env, so
// stub the runtime symbols used.
vi.mock("vscode", () => ({
  CancellationError: class extends Error {},
  workspace: { asRelativePath: (uri: any): string => uri.fsPath },
}));

// Real Pyodide-in-Node integration/parity test. Requires the bundled runtime
// (`npm run assets`); skipped gracefully when the assets are absent.
const assetsDir = path.resolve("assets/pyodide");
const hasAssets = existsSync(path.join(assetsDir, "pyodide.mjs"));

describe.skipIf(!hasAssets)("PyodideEngine (real Pyodide in Node)", () => {
  let engine: PyodideEngine;

  beforeAll(async () => {
    engine = new PyodideEngine(
      await buildWorker(),
      assetsDir,
      fakeOutputChannel(),
    );
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

  // Regression coverage for the uv-derived dependency closure: no other test
  // enables formatCss/formatJs, so cssbeautifier/jsbeautifier are otherwise
  // never actually imported inside the sandboxed Pyodide runtime — the exact
  // packages a closure regression (e.g. a stale/missing wheel) would break.
  // Golden output captured from the bundled djLint 1.42.3.
  test("format with formatCss/formatJs imports cssbeautifier/jsbeautifier and beautifies <style>/<script> contents", async () => {
    const input =
      "<html><head><style>.a{color:red}</style></head><body><script>var x=1;</script></body></html>";
    const expected =
      "<html>\n" +
      "    <head>\n" +
      "        <style>\n" +
      "            .a {\n" +
      "                color: red\n" +
      "            }\n" +
      "        </style>\n" +
      "    </head>\n" +
      "    <body>\n" +
      "        <script>\n" +
      "            var x = 1;\n" +
      "        </script>\n" +
      "    </body>\n" +
      "</html>\n";

    const out = await engine.format(
      fakeDocument(input),
      fakeConfig("html", { formatCss: true, formatJs: true }),
      fakeFormattingOptions,
      fakeToken,
    );
    expect(out).toBe(expected);
  }, 120_000);

  /* Regression coverage for Finding B: djlint.configuration/djlint.rules are
  file-path settings the bundled Pyodide runtime has no access to resolve.
  Before the fix, buildConfigKwargs() forwarded "rules" straight through to
  djLint's Config, which raised an uncaught FileNotFoundError for the
  (nonexistent, from this sandboxed runtime's point of view) path, silently
  breaking format/lint. Now buildConfigKwargs() never emits
  "configuration"/"rules" at all (see kwargs.test.ts), so this must format
  normally instead of throwing/rejecting. */
  test("djlint.rules set is silently ignored (not a throw) by the bundled runtime", async () => {
    const out = await engine.format(
      fakeDocument(FORMAT_INPUT),
      fakeConfig("django", { rules: "/nonexistent/rules.yaml" }),
      fakeFormattingOptions,
      fakeToken,
    );
    expect(out).toBe(FORMAT_EXPECTED);
  }, 120_000);

  test("djlint.configuration/djlint.rules being set logs one reminder, not one per call", async () => {
    const output = fakeOutputChannel();
    const localEngine = new PyodideEngine(
      await buildWorker(),
      assetsDir,
      output,
    );
    try {
      await localEngine.format(
        fakeDocument(FORMAT_INPUT),
        fakeConfig("django", { rules: "/nonexistent/rules.yaml" }),
        fakeFormattingOptions,
        fakeToken,
      );
      await localEngine.format(
        fakeDocument(FORMAT_INPUT),
        fakeConfig("django", { configuration: "/nonexistent/.djlintrc" }),
        fakeFormattingOptions,
        fakeToken,
      );
      await localEngine.lint(
        fakeDocument(LINT_INPUT),
        fakeConfig("django", { rules: "/nonexistent/rules.yaml" }),
        fakeToken,
      );

      expect(output.info).toHaveBeenCalledTimes(1);
      expect(output.info).toHaveBeenCalledWith(
        expect.stringContaining("djlint.rules"),
      );
    } finally {
      localEngine.dispose();
    }
  }, 120_000);
});

import { expect, test, vi } from "vitest";
import type { EngineSelectionDeps } from "../select.js";
import { RESOLUTION_TTL_MS } from "../subprocess/constants.js";
import { DjlintUnavailableError } from "../types.js";

/*
 * getEngine() in select.ts pulls in the two engines + config + the "vscode"
 * module, none of which resolve outside VS Code. Stub those hops so this file
 * can exercise the pure selectEngine() in isolation. `workspace.getWorkspaceFolder`
 * is a real vi.fn() (not just a stub returning `{}`), matching the pattern in
 * src/__tests__/runner.test.ts, so the FallbackEngine tests below can
 * configure it per-document to exercise per-scope fallback.
 */
vi.mock("vscode", () => ({ workspace: { getWorkspaceFolder: vi.fn() } }));
vi.mock("../subprocess/index.js", () => ({}));
vi.mock("../pyodide/index.js", () => ({}));
vi.mock("../../config.js", () => ({}));

const vscode = await import("vscode");
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

// Two documents in two different (fake) workspace folders, plus one with no
// workspace folder at all, to exercise FallbackEngine's per-scope keying.
// `document.uri` is just an opaque token here: the mocked
// `workspace.getWorkspaceFolder()` below maps it to a folder (or `undefined`)
// without caring what shape a real vscode.Uri has.
const docA: any = { uri: "doc-a" };
const docB: any = { uri: "doc-b" };
const docNoFolder: any = { uri: "doc-no-folder" };

function mockWorkspaceFolders(map: Record<string, string>): void {
  const table = new Map(Object.entries(map));
  vi.mocked(vscode.workspace.getWorkspaceFolder).mockImplementation(
    (uri: any): any => {
      const folderUri = table.get(uri);
      if (folderUri == null) {
        return void 0;
      }
      const folder: any = { uri: { toString: (): string => folderUri } };
      return folder;
    },
  );
}

test("FallbackEngine switches an unavailable scope to secondary, logs once, stays switched for that scope", async () => {
  mockWorkspaceFolders({ "doc-a": "file:///a" });
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

  expect(await engine.format(docA, config, fmtOpts, token)).toBe(
    "secondary-format",
  );
  expect(output.info).toHaveBeenCalledTimes(1);

  // A second call for the SAME scope goes straight to the secondary: the
  // primary is not retried and the secondary is reused (created once).
  await engine.format(docA, config, fmtOpts, token);
  expect(primary.format).toHaveBeenCalledTimes(1);
  expect(makeSecondary).toHaveBeenCalledTimes(1);
  expect(output.info).toHaveBeenCalledTimes(1);
});

test("FallbackEngine: a different scope still tries its own primary (no multi-root contamination)", async () => {
  mockWorkspaceFolders({ "doc-a": "file:///a", "doc-b": "file:///b" });
  const output: any = { info: vi.fn() };
  const primary = fakeEngine({
    format: vi.fn(async (document: any) => {
      if (document === docA) {
        throw new DjlintUnavailableError("no djlint in folder a");
      }
      return "primary-format";
    }),
  });
  const secondary = fakeEngine({
    format: vi.fn(async () => "secondary-format"),
  });
  const engine = new FallbackEngine(
    primary,
    vi.fn(() => secondary),
    output,
  );

  // Folder A has no djLint: falls back to the secondary.
  expect(await engine.format(docA, config, fmtOpts, token)).toBe(
    "secondary-format",
  );
  // Folder B has a working djLint: still tries (and succeeds on) the
  // primary, unaffected by folder A's fallback state.
  expect(await engine.format(docB, config, fmtOpts, token)).toBe(
    "primary-format",
  );

  expect(primary.format).toHaveBeenCalledTimes(2);
  expect(secondary.format).toHaveBeenCalledTimes(1);
});

test("FallbackEngine: after RESOLUTION_TTL_MS elapses, the same scope retries the primary (self-heal)", async () => {
  mockWorkspaceFolders({ "doc-a": "file:///a" });
  const output: any = { info: vi.fn() };
  const primary = fakeEngine({
    format: vi.fn(async () => {
      throw new DjlintUnavailableError("no djlint");
    }),
  });
  const secondary = fakeEngine({
    format: vi.fn(async () => "secondary-format"),
  });
  const engine = new FallbackEngine(
    primary,
    vi.fn(() => secondary),
    output,
  );

  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    await engine.format(docA, config, fmtOpts, token);
    expect(primary.format).toHaveBeenCalledTimes(1);

    // Still within the TTL window: cached, primary not retried.
    vi.setSystemTime(RESOLUTION_TTL_MS - 1);
    await engine.format(docA, config, fmtOpts, token);
    expect(primary.format).toHaveBeenCalledTimes(1);

    // TTL has elapsed: the primary is retried. Let it succeed this time,
    // simulating `pip install djlint` having happened in the meantime.
    vi.setSystemTime(RESOLUTION_TTL_MS);
    primary.format.mockImplementationOnce(async () => "primary-format");
    expect(await engine.format(docA, config, fmtOpts, token)).toBe(
      "primary-format",
    );
    expect(primary.format).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("FallbackEngine rethrows a non-DjlintUnavailableError without switching", async () => {
  // No folders configured: docNoFolder resolves to the "no workspace
  // folder" scope, same as it would with a real, unmapped document.
  mockWorkspaceFolders({});
  const output: any = { info: vi.fn() };
  const boom = new Error("real failure");
  const primary = fakeEngine({
    format: vi.fn(async () => {
      throw boom;
    }),
  });
  const makeSecondary = vi.fn(() => fakeEngine());
  const engine = new FallbackEngine(primary, makeSecondary, output);

  await expect(engine.format(docNoFolder, config, fmtOpts, token)).rejects.toBe(
    boom,
  );
  expect(makeSecondary).not.toHaveBeenCalled();
  expect(output.info).not.toHaveBeenCalled();
});

test("FallbackEngine.lint also switches to secondary on DjlintUnavailableError", async () => {
  mockWorkspaceFolders({ "doc-a": "file:///a" });
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

  expect(await engine.lint(docA, config, token)).toEqual(diagnostics);
});

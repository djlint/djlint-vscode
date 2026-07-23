import { beforeEach, expect, test, vi } from "vitest";

/*
 * linter.ts pulls in vscode + ./config.js + ./engine/select.js (which itself
 * pulls in the full subprocess/pyodide engine stack). Stub all three so this
 * file can exercise Linter's gating logic (enableLinting + lintLanguages +
 * URI scheme) against a fake engine, matching the mocking pattern already
 * used in src/engine/__tests__/select.test.ts.
 */

class FakeCancellationTokenSource {
  token = {
    isCancellationRequested: false,
    onCancellationRequested: (): { dispose: () => void } => ({
      dispose: (): void => {},
    }),
  };

  cancel(): void {
    this.token.isCancellationRequested = true;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  dispose(): void {}
}

function fakeDiagnosticCollection(): {
  delete: ReturnType<typeof vi.fn>;
  has: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  store: Map<unknown, unknown>;
} {
  const store = new Map();
  return {
    delete: vi.fn((uri: unknown) => store.delete(uri)),
    has: vi.fn((uri: unknown) => store.has(uri)),
    set: vi.fn((uri: unknown, diags: unknown) => store.set(uri, diags)),
    store,
  };
}

// Mutable test fixtures, held as properties (not reassigned top-level
// bindings) so vitest's own mock-hoisting rules don't complain about
// module-scope variable reassignment from within a function.
const state: {
  collection: ReturnType<typeof fakeDiagnosticCollection> | undefined;
  docs: unknown[];
  settings: Record<string, unknown>;
} = { collection: void 0, docs: [], settings: {} };

vi.mock("vscode", () => ({
  CancellationTokenSource: FakeCancellationTokenSource,
  languages: {
    createDiagnosticCollection: vi.fn(() => {
      state.collection = fakeDiagnosticCollection();
      return state.collection;
    }),
  },
  workspace: {
    onDidCloseTextDocument: vi.fn(() => ({ dispose: (): void => {} })),
    onDidOpenTextDocument: vi.fn(() => ({ dispose: (): void => {} })),
    onDidSaveTextDocument: vi.fn(() => ({ dispose: (): void => {} })),
    get textDocuments() {
      return state.docs;
    },
  },
}));

vi.mock("../config.js", () => ({
  getConfig: () => ({ get: (key: string): unknown => state.settings[key] }),
}));

const fakeEngine = {
  dispose: vi.fn(),
  format: vi.fn(),
  lint: vi.fn(async () => []),
};
vi.mock("../engine/select.js", () => ({ getEngine: () => fakeEngine }));

const { Linter } = await import("../linter.js");

function fakeDocument(languageId: string): any {
  return {
    languageId,
    uri: { scheme: "file", toString: () => `file:///${languageId}.html` },
  };
}

function fakeContext(): any {
  return { subscriptions: [] };
}

function fakeOutputChannel(): any {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

beforeEach(() => {
  fakeEngine.lint.mockClear();
  state.docs = [];
  state.settings = {};
  state.collection = void 0;
});

test("enabled + language in lintLanguages -> lints the document", async () => {
  state.settings = { enableLinting: true, lintLanguages: ["django-html"] };
  state.docs = [fakeDocument("django-html")];

  const linter = new Linter(fakeContext(), fakeOutputChannel());
  await linter.activate();

  expect(fakeEngine.lint).toHaveBeenCalledTimes(1);
  expect(state.collection?.set).toHaveBeenCalledTimes(1);
  expect(state.collection?.delete).not.toHaveBeenCalled();
});

test("enabled + language NOT in lintLanguages -> skips linting and clears diagnostics", async () => {
  state.settings = { enableLinting: true, lintLanguages: ["django-html"] };
  state.docs = [fakeDocument("python")];

  const linter = new Linter(fakeContext(), fakeOutputChannel());
  await linter.activate();

  expect(fakeEngine.lint).not.toHaveBeenCalled();
  expect(state.collection?.delete).toHaveBeenCalled();
  expect(state.collection?.set).not.toHaveBeenCalled();
});

test("enableLinting disabled -> still skips regardless of lintLanguages", async () => {
  state.settings = { enableLinting: false, lintLanguages: ["django-html"] };
  state.docs = [fakeDocument("django-html")];

  const linter = new Linter(fakeContext(), fakeOutputChannel());
  await linter.activate();

  expect(fakeEngine.lint).not.toHaveBeenCalled();
  expect(state.collection?.delete).toHaveBeenCalled();
});

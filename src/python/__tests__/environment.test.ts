import { beforeEach, expect, test, vi } from "vitest";

/*
 * Unlike runner.test.ts (which stubs "../python/environment.js" away
 * entirely), this file exercises the REAL environment.ts end to end,
 * including its module-level lazy-activation singleton (`pending`/
 * `lastResult`). That's deliberate: Finding 1 was that the classic Python
 * extension's `onDidChangeActiveEnvironmentPath` listener registration was
 * declared but never actually wired up in production code -- only a test
 * mock ever triggered it, which is exactly how 61 green tests missed a dead
 * `onDidChangeActivePythonEnvironment`. Mocking environment.ts away here
 * would reproduce that same blind spot, so instead we stub only "vscode"
 * (and, transitively, "@vscode/python-extension", which imports "vscode"
 * itself) with a minimal fake event emitter/Uri.
 */
vi.mock("vscode", () => {
  class FakeEventEmitter {
    readonly #listeners = new Set<(event: unknown) => void>();
    event = (listener: (event: unknown) => void): { dispose: () => void } => {
      this.#listeners.add(listener);
      return {
        dispose: (): void => {
          this.#listeners.delete(listener);
        },
      };
    };
    fire(event: unknown): void {
      for (const listener of this.#listeners) {
        listener(event);
      }
    }
  }

  class FakeUri {
    private constructor(readonly fsPath: string) {}
    static file(fsPath: string): FakeUri {
      return new FakeUri(fsPath);
    }
  }

  return { EventEmitter: FakeEventEmitter, Uri: FakeUri };
});

/*
 * `@vscode/python-extension` is a CJS package whose own `require("vscode")`
 * isn't intercepted by the "vscode" mock above (Vitest externalizes plain
 * node_modules CJS requires by default, bypassing its mock resolution).
 * Stub the package directly instead of teaching Vitest to inline it; the
 * default (unconfigured) behavior is "not available", matching the classic
 * extension not being installed.
 */
vi.mock("@vscode/python-extension", () => ({
  PythonExtension: {
    api: vi.fn(async () => {
      throw new Error("Python extension is not installed or is disabled");
    }),
  },
}));

const outputChannel: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

// Each test needs its own copy of environment.ts's module-level activation
// singleton (`pending`/`lastResult`), so a latched result (or a registered
// listener) from one test can't leak into another. Resetting the module
// registry also re-runs the "@vscode/python-extension" mock factory above,
// so each test gets a fresh, freshly-configurable `PythonExtension.api`
// mock too.
beforeEach(() => {
  vi.resetModules();
});

async function freshEnvironmentModule(): Promise<any> {
  const vscode: any = await import("vscode");
  const environmentModule = await import("../environment.js");
  return { vscode, ...environmentModule };
}

/** A fake classic Python extension (`ms-python.python`) API whose
`environments.onDidChangeActiveEnvironmentPath` is a real (fake) event
emitter so a test can `.fire()` it exactly like the real extension would. */
function fakeClassicPythonExtensionApi(vscode: any): {
  api: any;
  emitter: any;
} {
  const emitter = new vscode.EventEmitter();
  const onDidChangeActiveEnvironmentPath = vi.fn(emitter.event);
  return {
    api: {
      environments: {
        getActiveEnvironmentPath: vi.fn(() => "/env/a/bin/python"),
        onDidChangeActiveEnvironmentPath,
        // A resolvable environment by default, so a successful activation
        // is distinguishable (via getActivePythonEnvironment()'s non-null
        // return) from "the extension is unavailable" without a separate
        // provider-object getter. Tests exercising "no active environment"
        // override this explicitly.
        resolveEnvironment: vi.fn(async () => ({
          executable: { uri: { fsPath: "/env/a/bin/python" } },
        })),
      },
    },
    emitter,
  };
}

test("Finding 1: getActivePythonEnvironment() actually wires the classic Python extension's change event through to onDidChangeActivePythonEnvironment (the listener registration is no longer dead code)", async () => {
  const { PythonExtension } = await import("@vscode/python-extension");
  const {
    initializePythonEnvironment,
    getActivePythonEnvironment,
    onDidChangeActivePythonEnvironment,
  } = await freshEnvironmentModule();
  const vscode: any = await import("vscode");
  const { api, emitter } = fakeClassicPythonExtensionApi(vscode);
  vi.mocked(PythonExtension.api).mockResolvedValue(api);

  const disposables: unknown[] = [];
  initializePythonEnvironment(disposables, outputChannel);
  // initializePythonEnvironment() bridges its own disposables into the array
  // it's given, but (per the lazy-activation test below) does NOT itself
  // register the listener yet.
  expect(disposables).toHaveLength(1);
  expect(
    api.environments.onDidChangeActiveEnvironmentPath,
  ).not.toHaveBeenCalled();

  await getActivePythonEnvironment();
  // The whole bug was that this listener registration never happened.
  expect(
    api.environments.onDidChangeActiveEnvironmentPath,
  ).toHaveBeenCalledTimes(1);

  let fired = 0;
  onDidChangeActivePythonEnvironment(() => {
    fired += 1;
  });

  emitter.fire({
    path: "/env/a/bin/python",
    resource: vscode.Uri.file("/workspace/project"),
  });

  expect(fired).toBe(1);
});

test("initializePythonEnvironment() does not activate the classic Python extension by itself; activation is lazy, on the first getActivePythonEnvironment() call", async () => {
  const { PythonExtension } = await import("@vscode/python-extension");
  const { initializePythonEnvironment, getActivePythonEnvironment } =
    await freshEnvironmentModule();
  const vscode: any = await import("vscode");
  const { api } = fakeClassicPythonExtensionApi(vscode);
  // mockClear() first: despite vi.resetModules() in beforeEach, this mock's
  // call history has been observed to survive across tests in this file
  // (unlike the fakeClassicPythonExtensionApi()-local mocks, which are
  // rebuilt fresh every test), so clear it explicitly rather than relying on
  // an absolute "never called" baseline that a preceding test could taint.
  vi.mocked(PythonExtension.api).mockClear().mockResolvedValue(api);

  const disposables: unknown[] = [];
  initializePythonEnvironment(disposables, outputChannel);

  // Regression coverage for the eager `await getClassicPythonExtension(...)`
  // this used to make: activating ms-python.python for EVERY user on djLint
  // startup, even one on executablePath/useVenv:false/no-djLint-file who
  // never needs it.
  expect(PythonExtension.api).not.toHaveBeenCalled();

  await getActivePythonEnvironment();

  expect(PythonExtension.api).toHaveBeenCalledTimes(1);
});

test("getActivePythonEnvironment(): returns null when the Python extension is absent, without throwing", async () => {
  const { getActivePythonEnvironment } = await freshEnvironmentModule();
  const { PythonExtension } = await import("@vscode/python-extension");
  // Explicit, rather than relying on the mock factory's own default reject
  // behavior surviving vi.resetModules() (every other test in this file
  // configures PythonExtension.api explicitly for the same reason).
  vi.mocked(PythonExtension.api).mockRejectedValue(
    new Error("Python extension is not installed or is disabled"),
  );

  await expect(getActivePythonEnvironment()).resolves.toBeNull();
});

test("Finding 5: a latched 'the classic Python extension is unavailable' result is retried after resetPythonEnvironmentProviderIfUnavailable(), without disturbing an already-activated extension", async () => {
  const { PythonExtension } = await import("@vscode/python-extension");
  const {
    getActivePythonEnvironment,
    resetPythonEnvironmentProviderIfUnavailable,
  } = await freshEnvironmentModule();

  // The classic extension isn't installed/available yet.
  vi.mocked(PythonExtension.api).mockRejectedValue(
    new Error("Python extension is not installed or is disabled"),
  );
  expect(await getActivePythonEnvironment()).toBeNull();

  // The classic extension becomes available -- but without a reset, the
  // earlier failure stays latched.
  const vscode: any = await import("vscode");
  const { api } = fakeClassicPythonExtensionApi(vscode);
  vi.mocked(PythonExtension.api).mockResolvedValue(api);
  expect(await getActivePythonEnvironment()).toBeNull();

  resetPythonEnvironmentProviderIfUnavailable();

  expect(await getActivePythonEnvironment()).not.toBeNull();
  expect(
    api.environments.onDidChangeActiveEnvironmentPath,
  ).toHaveBeenCalledTimes(1);

  // Resetting again, after activation already succeeded, must not
  // re-activate: the memoized extension (and its listener registration) is
  // left alone.
  resetPythonEnvironmentProviderIfUnavailable();
  expect(await getActivePythonEnvironment()).not.toBeNull();
  expect(
    api.environments.onDidChangeActiveEnvironmentPath,
  ).toHaveBeenCalledTimes(1);
});

test("getActivePythonEnvironment(): maps a resolved classic environment to a command, with no sysPrefix field", async () => {
  const { PythonExtension } = await import("@vscode/python-extension");
  const { getActivePythonEnvironment } = await freshEnvironmentModule();
  const vscode: any = await import("vscode");
  const { api } = fakeClassicPythonExtensionApi(vscode);
  api.environments.resolveEnvironment = vi.fn(async () => ({
    executable: { sysPrefix: "/env/a", uri: { fsPath: "/env/a/bin/python" } },
  }));
  vi.mocked(PythonExtension.api).mockResolvedValue(api);

  const details = await getActivePythonEnvironment();

  expect(details).toStrictEqual({
    command: { args: [], executable: "/env/a/bin/python" },
  });
});

test("getActivePythonEnvironment(): guard E -- never throws, even when the Python extension itself throws from resolveEnvironment()", async () => {
  const { PythonExtension } = await import("@vscode/python-extension");
  const { getActivePythonEnvironment } = await freshEnvironmentModule();
  const vscode: any = await import("vscode");
  const { api } = fakeClassicPythonExtensionApi(vscode);
  api.environments.resolveEnvironment = vi.fn(async () => {
    throw new Error("boom: a misbehaving Python extension");
  });
  vi.mocked(PythonExtension.api).mockResolvedValue(api);

  await expect(getActivePythonEnvironment()).resolves.toBeNull();
});

test("getActivePythonEnvironment(): guard E -- never throws, even when getActiveEnvironmentPath() itself throws", async () => {
  const { PythonExtension } = await import("@vscode/python-extension");
  const { getActivePythonEnvironment } = await freshEnvironmentModule();
  const vscode: any = await import("vscode");
  const { api } = fakeClassicPythonExtensionApi(vscode);
  api.environments.getActiveEnvironmentPath = vi.fn(() => {
    throw new Error("boom: a misbehaving Python extension");
  });
  vi.mocked(PythonExtension.api).mockResolvedValue(api);

  await expect(getActivePythonEnvironment()).resolves.toBeNull();
});

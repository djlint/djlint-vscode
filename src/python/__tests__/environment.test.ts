import { beforeEach, expect, test, vi } from "vitest";

/*
 * Unlike runner.test.ts (which stubs "../python/environment.js" away
 * entirely), this file exercises the REAL environment.ts end to end,
 * including its module-level `lazyInit()` activation singleton. That's
 * deliberate: Finding 1 was that `EnvironmentProvider.initialize()` is
 * declared on the interface and implemented by the provider class, but was
 * never actually invoked anywhere in production code -- only a test mock
 * ever called it, which is exactly how 61 green tests missed a dead
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
// singleton (`classicPythonExtension`), so a latched result (or a
// registered listener) from one test can't leak into another. Resetting the
// module registry also re-runs the "@vscode/python-extension" mock factory
// above, so each test gets a fresh, freshly-configurable `PythonExtension.api`
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
        resolveEnvironment: vi.fn(async () => null),
      },
    },
    emitter,
  };
}

test("Finding 1: getEnvironmentProvider() actually wires the classic Python extension's change event through to onDidChangeActivePythonEnvironment (initialize() is no longer dead code)", async () => {
  const { vscode, getEnvironmentProvider, onDidChangeActivePythonEnvironment } =
    await freshEnvironmentModule();
  const { PythonExtension } = await import("@vscode/python-extension");
  const { api, emitter } = fakeClassicPythonExtensionApi(vscode);
  vi.mocked(PythonExtension.api).mockResolvedValue(api);

  const provider = await getEnvironmentProvider(outputChannel);
  expect(provider).not.toBeNull();
  // The whole bug was that this listener registration never happened.
  expect(
    api.environments.onDidChangeActiveEnvironmentPath,
  ).toHaveBeenCalledTimes(1);

  const changes: unknown[] = [];
  onDidChangeActivePythonEnvironment((change: unknown) => {
    changes.push(change);
  });

  const uri = vscode.Uri.file("/workspace/project");
  emitter.fire({ path: "/env/a/bin/python", resource: uri });

  expect(changes).toEqual([{ path: "/env/a/bin/python", uri }]);
});

test("Finding 5: a latched 'no environment provider available' result is retried after resetUnavailableEnvironmentProviders(), without disturbing an already-activated provider", async () => {
  const {
    vscode,
    getEnvironmentProvider,
    resetUnavailableEnvironmentProviders,
  } = await freshEnvironmentModule();
  const { PythonExtension } = await import("@vscode/python-extension");

  // The classic extension isn't installed/available yet.
  vi.mocked(PythonExtension.api).mockRejectedValue(
    new Error("Python extension is not installed or is disabled"),
  );
  expect(await getEnvironmentProvider(outputChannel)).toBeNull();

  // The classic extension becomes available -- but without a reset, the
  // earlier failure stays latched.
  const { api } = fakeClassicPythonExtensionApi(vscode);
  vi.mocked(PythonExtension.api).mockResolvedValue(api);
  expect(await getEnvironmentProvider(outputChannel)).toBeNull();

  resetUnavailableEnvironmentProviders();

  const provider = await getEnvironmentProvider(outputChannel);
  expect(provider).not.toBeNull();
  expect(
    api.environments.onDidChangeActiveEnvironmentPath,
  ).toHaveBeenCalledTimes(1);

  // Resetting again, after a provider already activated successfully, must
  // not re-run initialize(): the memoized provider (and its listener
  // registration) is left alone.
  resetUnavailableEnvironmentProviders();
  const providerAgain = await getEnvironmentProvider(outputChannel);
  expect(providerAgain).toBe(provider);
  expect(
    api.environments.onDidChangeActiveEnvironmentPath,
  ).toHaveBeenCalledTimes(1);
});

test("getActiveEnvironment(): maps a resolved classic environment to command/sysPrefix, with no version field", async () => {
  const { vscode, getEnvironmentProvider } = await freshEnvironmentModule();
  const { PythonExtension } = await import("@vscode/python-extension");
  const { api } = fakeClassicPythonExtensionApi(vscode);
  api.environments.resolveEnvironment = vi.fn(async () => ({
    executable: { sysPrefix: "/env/a", uri: { fsPath: "/env/a/bin/python" } },
  }));
  vi.mocked(PythonExtension.api).mockResolvedValue(api);

  const provider = await getEnvironmentProvider(outputChannel);
  const details = await provider?.getActiveEnvironment();

  expect(details).toStrictEqual({
    command: { args: [], executable: "/env/a/bin/python" },
    sysPrefix: "/env/a",
  });
});

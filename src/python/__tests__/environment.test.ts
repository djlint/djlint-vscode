import { beforeEach, expect, test, vi } from "vitest";

/*
 * Unlike runner.test.ts (which stubs "../python/environment.js" away
 * entirely), this file exercises the REAL environment.ts end to end,
 * including its module-level `lazyInit()` activation singletons. That's
 * deliberate: Finding 1 was that `EnvironmentProvider.initialize()` is
 * declared on the interface and implemented by both provider classes, but
 * was never actually invoked anywhere in production code -- only a test
 * mock ever called it, which is exactly how 61 green tests missed a dead
 * `onDidChangeActivePythonEnvironment`. Mocking environment.ts away here
 * would reproduce that same blind spot, so instead we stub only "vscode"
 * (and, transitively, "@vscode/python-extension", which imports "vscode"
 * itself) with a minimal fake extension registry/event emitter/Uri.
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

  return {
    EventEmitter: FakeEventEmitter,
    Uri: FakeUri,
    extensions: { getExtension: vi.fn() },
  };
});

/*
 * `@vscode/python-extension` is a CJS package whose own `require("vscode")`
 * isn't intercepted by the "vscode" mock above (Vitest externalizes plain
 * node_modules CJS requires by default, bypassing its mock resolution). None
 * of these tests exercise the classic-extension path, so stub the package
 * directly instead of teaching Vitest to inline it.
 */
vi.mock("@vscode/python-extension", () => ({
  PythonExtension: {
    api: vi.fn(async () => {
      throw new Error("Python extension is not installed or is disabled");
    }),
  },
}));

const pythonEnvironmentsExtensionId = "ms-python.vscode-python-envs";

const outputChannel: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

// Each test needs its own copy of environment.ts's module-level activation
// singletons (`classicPythonExtension`/`pythonEnvironmentsExtension`), so a
// latched result (or a registered listener) from one test can't leak into
// another.
beforeEach(() => {
  vi.resetModules();
});

async function freshEnvironmentModule(): Promise<any> {
  const vscode: any = await import("vscode");
  const environmentModule = await import("../environment.js");
  return { vscode, ...environmentModule };
}

/** A fake Python Environments extension (`ms-python.vscode-python-envs`),
already active, whose `onDidChangeEnvironment` is a real (fake) event
emitter so a test can `.fire()` it exactly like the real extension would. */
function fakePythonEnvironmentsExtension(vscode: any): {
  emitter: any;
  extension: any;
} {
  const emitter = new vscode.EventEmitter();
  const onDidChangeEnvironment = vi.fn(emitter.event);
  return {
    emitter,
    extension: {
      exports: {
        getEnvironment: vi.fn(async () => null),
        onDidChangeEnvironment,
        resolveEnvironment: vi.fn(async () => null),
      },
      isActive: true,
    },
  };
}

test("Finding 1: getEnvironmentProvider() actually wires the underlying provider's change event through to onDidChangeActivePythonEnvironment (initialize() is no longer dead code)", async () => {
  const { vscode, getEnvironmentProvider, onDidChangeActivePythonEnvironment } =
    await freshEnvironmentModule();
  const { emitter, extension } = fakePythonEnvironmentsExtension(vscode);
  vscode.extensions.getExtension.mockImplementation((id: string) =>
    id === pythonEnvironmentsExtensionId ? extension : void 0,
  );

  const provider = await getEnvironmentProvider(outputChannel);
  expect(provider).not.toBeNull();
  // The whole bug was that this listener registration never happened.
  expect(extension.exports.onDidChangeEnvironment).toHaveBeenCalledTimes(1);

  const changes: unknown[] = [];
  onDidChangeActivePythonEnvironment((change: unknown) => {
    changes.push(change);
  });

  const uri = vscode.Uri.file("/workspace/project");
  emitter.fire({
    new: {
      environmentPath: { fsPath: "/env/a" },
      error: void 0,
      execInfo: { run: { args: [], executable: "/env/a/bin/python" } },
      sysPrefix: "/env/a",
      version: "3.12.1",
    },
    old: void 0,
    uri,
  });

  expect(changes).toEqual([{ path: "/env/a/bin/python", uri }]);
});

test("Finding 5: a latched 'no environment provider available' result is retried after resetUnavailableEnvironmentProviders(), without disturbing an already-activated provider", async () => {
  const {
    vscode,
    getEnvironmentProvider,
    resetUnavailableEnvironmentProviders,
  } = await freshEnvironmentModule();

  // Neither extension is installed/active yet.
  vscode.extensions.getExtension.mockReturnValue(void 0);
  expect(await getEnvironmentProvider(outputChannel)).toBeNull();

  // The Python Environments extension becomes available -- but without a
  // reset, the earlier failure stays latched.
  const { extension } = fakePythonEnvironmentsExtension(vscode);
  vscode.extensions.getExtension.mockImplementation((id: string) =>
    id === pythonEnvironmentsExtensionId ? extension : void 0,
  );
  expect(await getEnvironmentProvider(outputChannel)).toBeNull();

  resetUnavailableEnvironmentProviders();

  const provider = await getEnvironmentProvider(outputChannel);
  expect(provider).not.toBeNull();
  expect(extension.exports.onDidChangeEnvironment).toHaveBeenCalledTimes(1);

  // Resetting again, after a provider already activated successfully, must
  // not re-run initialize(): the memoized provider (and its listener
  // registration) is left alone.
  resetUnavailableEnvironmentProviders();
  const providerAgain = await getEnvironmentProvider(outputChannel);
  expect(providerAgain).toBe(provider);
  expect(extension.exports.onDidChangeEnvironment).toHaveBeenCalledTimes(1);
});

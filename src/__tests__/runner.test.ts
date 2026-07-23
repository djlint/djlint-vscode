import { beforeEach, expect, test, vi } from "vitest";
import type {
  EnvironmentProvider,
  PythonEnvironmentDetails,
} from "../python/environment.js";

/*
 * runner.ts imports "vscode" (not resolvable outside a real extension host)
 * and "../python/environment.js" (which itself pulls in "vscode" and the two
 * Python-extension packages). Stub those hops so this file can exercise the
 * pure resolveDjlintCommand() in isolation, matching the pattern already
 * used in src/engine/__tests__/select.test.ts.
 */
vi.mock("vscode", () => ({}));
vi.mock("execa", () => ({
  ExecaError: class ExecaError extends Error {},
  execa: vi.fn(),
}));
vi.mock("../python/environment.js", () => ({
  getEnvironmentProvider: vi.fn(),
  resetUnavailableEnvironmentProviders: vi.fn(),
}));

const {
  resolveDjlintCommand,
  resolveDjlintCommandCached,
  invalidateDjlintCommandCache,
  isExplicitlySet,
} = await import("../runner.js");
const { DjlintUnavailableError } = await import("../engine/types.js");
type ResolveDjlintCommandDeps = Parameters<typeof resolveDjlintCommand>[0];

// resolveDjlintCommandCached() shares a module-level cache across every test
// in this file; start each test from a clean slate so caching tests can't
// leak into (or be polluted by) one another.
beforeEach(() => {
  invalidateDjlintCommandCache();
});

function deps(
  over: Partial<ResolveDjlintCommandDeps> = {},
): ResolveDjlintCommandDeps {
  return {
    executablePath: void 0,
    interpreter: [],
    path: [],
    probe: vi.fn(async () => false),
    provider: null,
    uri: void 0,
    useVenv: true,
    ...over,
  };
}

function fakeProvider(
  over: Partial<EnvironmentProvider> = {},
): EnvironmentProvider {
  return {
    getActiveEnvironment: vi.fn(async () => null),
    initialize: vi.fn(async () => {}),
    resolveInterpreter: vi.fn(async () => null),
    ...over,
  };
}

function envDetails(
  command: PythonEnvironmentDetails["command"],
): PythonEnvironmentDetails {
  return { command, sysPrefix: "/env", version: null };
}

test("djlint.path: the first probing entry wins, as a plain CLI command", async () => {
  const probe = vi.fn(async (exec: string) => exec === "/good/djlint");
  const command = await resolveDjlintCommand(
    deps({ path: ["/bad/djlint", "/good/djlint", "/unreached/djlint"], probe }),
  );
  expect(command).toEqual({ exec: "/good/djlint", prefixArgs: [] });
  expect(probe).toHaveBeenCalledTimes(2);
});

test("djlint.path wins over djlint.interpreter", async () => {
  const provider = fakeProvider();
  const command = await resolveDjlintCommand(
    deps({
      interpreter: ["/some/python"],
      path: ["/good/djlint"],
      probe: vi.fn(async () => true),
      provider,
    }),
  );
  expect(command).toEqual({ exec: "/good/djlint", prefixArgs: [] });
  expect(provider.resolveInterpreter).not.toHaveBeenCalled();
});

test("djlint.path entries that never probe successfully fall through to later steps", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: [], executable: "/active/python" }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({ path: ["/bad/djlint"], probe: vi.fn(async () => false), provider }),
  );
  expect(command).toEqual({
    exec: "/active/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("resolveDjlintCommand honors any present executablePath, including the old default value ('djlint') — 'explicitly set' is decided by the caller via isExplicitlySet()/config.inspect(), not by resolveDjlintCommand itself", async () => {
  const provider = fakeProvider();
  const command = await resolveDjlintCommand(
    deps({
      executablePath: "djlint",
      interpreter: ["/some/python"],
      probe: vi.fn(async () => true),
      provider,
    }),
  );
  expect(command).toEqual({ exec: "djlint", prefixArgs: [] });
  // Step 3 (djlint.interpreter) must never be consulted: step 2 already won.
  expect(provider.resolveInterpreter).not.toHaveBeenCalled();
});

test("isExplicitlySet(): false when the config only ever reports its own default value back (never set by the user)", () => {
  const config: any = { inspect: vi.fn(() => ({ defaultValue: "djlint" })) };
  expect(isExplicitlySet(config, "executablePath")).toBe(false);
});

test("isExplicitlySet(): true when explicitly set at workspace scope, even to the setting's own default value", () => {
  const config: any = {
    inspect: vi.fn(() => ({
      defaultValue: "djlint",
      workspaceValue: "djlint",
    })),
  };
  expect(isExplicitlySet(config, "executablePath")).toBe(true);
});

test("isExplicitlySet(): true when explicitly set at the global (user) scope", () => {
  const config: any = {
    inspect: vi.fn(() => ({
      defaultValue: "djlint",
      globalValue: "/custom/djlint",
    })),
  };
  expect(isExplicitlySet(config, "executablePath")).toBe(true);
});

test("isExplicitlySet(): true when explicitly set at workspace-folder scope", () => {
  const config: any = {
    inspect: vi.fn(() => ({
      defaultValue: "djlint",
      workspaceFolderValue: "/custom/djlint",
    })),
  };
  expect(isExplicitlySet(config, "executablePath")).toBe(true);
});

test("isExplicitlySet(): false when inspect() returns nothing at all (section never registered)", () => {
  const config: any = { inspect: vi.fn(() => void 0) };
  expect(isExplicitlySet(config, "executablePath")).toBe(false);
});

test("deprecated djlint.executablePath wins over djlint.interpreter and the active environment", async () => {
  const provider = fakeProvider();
  const command = await resolveDjlintCommand(
    deps({
      executablePath: "/custom/djlint",
      interpreter: ["/some/python"],
      probe: vi.fn(async () => true),
      provider,
    }),
  );
  expect(command).toEqual({ exec: "/custom/djlint", prefixArgs: [] });
  expect(provider.resolveInterpreter).not.toHaveBeenCalled();
  expect(provider.getActiveEnvironment).not.toHaveBeenCalled();
});

test("djlint.interpreter wins over the active environment", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () => {
      throw new Error("should not be reached: interpreter[] should win");
    }),
    resolveInterpreter: vi.fn(async (p: string) =>
      envDetails({ args: [], executable: p }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({
      interpreter: ["/venv/bin/python"],
      probe: vi.fn(async () => true),
      provider,
    }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("djlint.interpreter: resolved environment args are preserved and -m djlint is appended", async () => {
  const provider = fakeProvider({
    resolveInterpreter: vi.fn(async () =>
      envDetails({ args: ["run", "-p", "3.12"], executable: "/usr/bin/uv" }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({ interpreter: ["uv"], probe: vi.fn(async () => true), provider }),
  );
  expect(command).toEqual({
    exec: "/usr/bin/uv",
    prefixArgs: ["run", "-p", "3.12", "-m", "djlint"],
  });
});

test("djlint.interpreter: falls back to the raw entry when the provider is null, if it probes successfully", async () => {
  const command = await resolveDjlintCommand(
    deps({
      interpreter: ["/venv/bin/python"],
      probe: vi.fn(async () => true),
      provider: null,
    }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("djlint.interpreter: falls back to the raw entry when the provider cannot resolve it, if it probes successfully", async () => {
  const provider = fakeProvider({
    resolveInterpreter: vi.fn(async () => null),
  });
  const command = await resolveDjlintCommand(
    deps({
      interpreter: ["/venv/bin/python"],
      probe: vi.fn(async () => true),
      provider,
    }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("djlint.interpreter: blank entries are skipped", async () => {
  const provider = fakeProvider({
    resolveInterpreter: vi.fn(async (p: string) =>
      envDetails({ args: [], executable: p }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({
      interpreter: ["  ", "/venv/bin/python"],
      probe: vi.fn(async () => true),
      provider,
    }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("djlint.interpreter: a first entry that resolves but fails to probe falls through to a working second entry", async () => {
  const provider = fakeProvider({
    resolveInterpreter: vi.fn(async (p: string) =>
      envDetails({ args: [], executable: p }),
    ),
  });
  const probe = vi.fn(async (exec: string) => exec === "/good/python");
  const command = await resolveDjlintCommand(
    deps({ interpreter: ["/bad/python", "/good/python"], probe, provider }),
  );
  expect(command).toEqual({
    exec: "/good/python",
    prefixArgs: ["-m", "djlint"],
  });
  expect(provider.resolveInterpreter).toHaveBeenNthCalledWith(1, "/bad/python");
  expect(provider.resolveInterpreter).toHaveBeenNthCalledWith(
    2,
    "/good/python",
  );
});

test("djlint.interpreter: a first entry the provider cannot resolve (and whose raw path also fails to probe) falls through to a working second entry", async () => {
  const provider = fakeProvider({
    resolveInterpreter: vi.fn(async (p: string) =>
      p === "/good/python" ? envDetails({ args: [], executable: p }) : null,
    ),
  });
  const probe = vi.fn(async (exec: string) => exec === "/good/python");
  const command = await resolveDjlintCommand(
    deps({
      interpreter: ["/unresolvable/python", "/good/python"],
      probe,
      provider,
    }),
  );
  expect(command).toEqual({
    exec: "/good/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("djlint.interpreter: all entries failing falls through to the active environment", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: [], executable: "/active/python" }),
    ),
    resolveInterpreter: vi.fn(async (p: string) =>
      envDetails({ args: [], executable: p }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({
      interpreter: ["/bad/python", "/also-bad/python"],
      probe: vi.fn(async () => false),
      provider,
    }),
  );
  expect(command).toEqual({
    exec: "/active/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("active environment: used with its args + -m djlint when nothing else is configured", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: ["run"], executable: "/active/python" }),
    ),
  });
  const command = await resolveDjlintCommand(deps({ provider }));
  expect(command).toEqual({
    exec: "/active/python",
    prefixArgs: ["run", "-m", "djlint"],
  });
});

test("deprecated djlint.useVenv: false skips the active-environment step", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () => {
      throw new Error("should not be reached: useVenv is false");
    }),
  });
  const command = await resolveDjlintCommand(
    deps({ probe: vi.fn(async () => true), provider, useVenv: false }),
  );
  expect(command).toEqual({ exec: "djlint", prefixArgs: [] });
  expect(provider.getActiveEnvironment).not.toHaveBeenCalled();
});

test("deprecated djlint.useVenv left at its default (true) still consults the active environment", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: [], executable: "/active/python" }),
    ),
  });
  const command = await resolveDjlintCommand(deps({ provider, useVenv: true }));
  expect(command).toEqual({
    exec: "/active/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("falls back to djlint on PATH when nothing else resolves", async () => {
  const command = await resolveDjlintCommand(
    deps({ probe: vi.fn(async (exec: string) => exec === "djlint") }),
  );
  expect(command).toEqual({ exec: "djlint", prefixArgs: [] });
});

test("throws DjlintUnavailableError when nothing resolves at all", async () => {
  await expect(
    resolveDjlintCommand(deps({ probe: vi.fn(async () => false) })),
  ).rejects.toBeInstanceOf(DjlintUnavailableError);
});

test("active environment with no command falls through to the PATH fallback", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () => envDetails(null)),
  });
  const command = await resolveDjlintCommand(
    deps({ probe: vi.fn(async () => true), provider }),
  );
  expect(command).toEqual({ exec: "djlint", prefixArgs: [] });
});

test("resolveDjlintCommandCached: a second resolution for the same scope does not re-probe", async () => {
  const probe = vi.fn(async (exec: string) => exec === "djlint");
  const d = deps({ probe });

  const first = await resolveDjlintCommandCached(d, "scope-a");
  const second = await resolveDjlintCommandCached(d, "scope-a");

  expect(first).toEqual({ exec: "djlint", prefixArgs: [] });
  expect(second).toEqual(first);
  expect(probe).toHaveBeenCalledTimes(1);
});

test("resolveDjlintCommandCached: invalidateDjlintCommandCache() forces a re-probe", async () => {
  const probe = vi.fn(async (exec: string) => exec === "djlint");
  const d = deps({ probe });

  await resolveDjlintCommandCached(d, "scope-a");
  invalidateDjlintCommandCache();
  await resolveDjlintCommandCached(d, "scope-a");

  expect(probe).toHaveBeenCalledTimes(2);
});

test("resolveDjlintCommandCached: different scopes are cached independently", async () => {
  const probe = vi.fn(async (exec: string) => exec === "djlint");
  const d = deps({ probe });

  await resolveDjlintCommandCached(d, "scope-a");
  await resolveDjlintCommandCached(d, "scope-b");
  // undefined is the shared global scope, distinct from either named scope.
  await resolveDjlintCommandCached(d, undefined);

  expect(probe).toHaveBeenCalledTimes(3);
});

test("resolveDjlintCommandCached: a failed resolution is not cached", async () => {
  const probe = vi.fn(async () => false);
  const d = deps({ probe });

  await expect(resolveDjlintCommandCached(d, "scope-a")).rejects.toBeInstanceOf(
    DjlintUnavailableError,
  );
  await expect(resolveDjlintCommandCached(d, "scope-a")).rejects.toBeInstanceOf(
    DjlintUnavailableError,
  );

  // Nothing was ever cached, so both resolutions independently reach (and
  // fail) the PATH fallback probe: 1 probe call each x 2 resolutions.
  expect(probe).toHaveBeenCalledTimes(2);
});

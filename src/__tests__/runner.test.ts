import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type {
  EnvironmentProvider,
  PythonEnvironmentDetails,
} from "../python/environment.js";

/*
 * runner.ts imports "vscode" (not resolvable outside a real extension host)
 * and "../python/environment.js" (which itself pulls in "vscode" and the two
 * Python-extension packages). Stub those hops so this file can exercise the
 * pure resolveDjlintCommand() (and the small relative-path helper) in
 * isolation, matching the pattern already used in
 * src/engine/__tests__/select.test.ts. `workspace.getWorkspaceFolder` is a
 * real vi.fn() (not just a stub returning `{}`) so tests can configure it
 * per-case to exercise relative-path resolution.
 */
vi.mock("vscode", () => ({ workspace: { getWorkspaceFolder: vi.fn() } }));
vi.mock("execa", () => ({
  ExecaError: class ExecaError extends Error {},
  execa: vi.fn(),
}));
vi.mock("../python/environment.js", () => ({
  getEnvironmentProvider: vi.fn(),
  resetUnavailableEnvironmentProviders: vi.fn(),
}));

const vscode = await import("vscode");
const {
  resolveDjlintCommand,
  resolveDjlintCommandCached,
  invalidateDjlintCommandCache,
  normalizeConfiguredExecutable,
} = await import("../runner.js");
const { DjlintUnavailableError } = await import("../engine/types.js");
type ResolveDjlintCommandDeps = Parameters<typeof resolveDjlintCommand>[0];

// resolveDjlintCommandCached() shares a module-level cache across every test
// in this file; start each test from a clean slate so caching tests can't
// leak into (or be polluted by) one another.
beforeEach(() => {
  invalidateDjlintCommandCache();
  vi.mocked(vscode.workspace.getWorkspaceFolder).mockReset();
});

function deps(
  over: Partial<ResolveDjlintCommandDeps> = {},
): ResolveDjlintCommandDeps {
  return {
    executablePath: "",
    probe: vi.fn(async () => false),
    provider: null,
    pythonPath: "",
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

test("djlint.executablePath: used directly when it probes successfully", async () => {
  const provider = fakeProvider();
  const probe = vi.fn(async (exec: string) => exec === "/custom/djlint");
  const command = await resolveDjlintCommand(
    deps({
      executablePath: "/custom/djlint",
      probe,
      provider,
      pythonPath: "/some/python",
    }),
  );
  expect(command).toEqual({ exec: "/custom/djlint", prefixArgs: [] });
  expect(probe).toHaveBeenCalledWith("/custom/djlint", []);
  // Later steps must never be consulted: step 1 already won.
  expect(provider.getActiveEnvironment).not.toHaveBeenCalled();
});

test("djlint.executablePath: falls through to djlint.pythonPath when it fails to probe", async () => {
  const probe = vi.fn(
    async (exec: string, prefixArgs: readonly string[]) =>
      exec === "/venv/bin/python" &&
      prefixArgs.length === 2 &&
      prefixArgs[0] === "-m" &&
      prefixArgs[1] === "djlint",
  );
  const command = await resolveDjlintCommand(
    deps({
      executablePath: "/bad/djlint",
      probe,
      pythonPath: "/venv/bin/python",
    }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("djlint.pythonPath: used (with -m djlint) when no executablePath is set", async () => {
  const probe = vi.fn(async (exec: string) => exec === "/venv/bin/python");
  const command = await resolveDjlintCommand(
    deps({ probe, pythonPath: "/venv/bin/python" }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
  });
  expect(probe).toHaveBeenCalledWith("/venv/bin/python", ["-m", "djlint"]);
});

test("djlint.pythonPath wins over the active environment", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () => {
      throw new Error("should not be reached: pythonPath should win");
    }),
  });
  const command = await resolveDjlintCommand(
    deps({
      probe: vi.fn(async () => true),
      provider,
      pythonPath: "/venv/bin/python",
    }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
  });
  expect(provider.getActiveEnvironment).not.toHaveBeenCalled();
});

test("active environment: used with its args + -m djlint when neither executablePath nor pythonPath resolve", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: ["run"], executable: "/active/python" }),
    ),
  });
  const probe = vi.fn(async (exec: string) => exec === "/active/python");
  const command = await resolveDjlintCommand(deps({ probe, provider }));
  expect(command).toEqual({
    exec: "/active/python",
    prefixArgs: ["run", "-m", "djlint"],
  });
  expect(probe).toHaveBeenCalledWith("/active/python", ["run", "-m", "djlint"]);
});

test("active environment: a conda/uv-style command's own launch args are preserved alongside -m djlint", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: ["run", "-p", "3.12"], executable: "/usr/bin/uv" }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({ probe: vi.fn(async () => true), provider }),
  );
  expect(command).toEqual({
    exec: "/usr/bin/uv",
    prefixArgs: ["run", "-p", "3.12", "-m", "djlint"],
  });
});

test("active environment: a command that fails to probe falls through to the PATH fallback", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: [], executable: "/active/python" }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({ probe: vi.fn(async (exec: string) => exec === "djlint"), provider }),
  );
  expect(command).toEqual({ exec: "djlint", prefixArgs: [] });
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

test("djlint.useVenv: false skips the active-environment step", async () => {
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

test("djlint.useVenv left at its default (true) still consults the active environment", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: [], executable: "/active/python" }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({ probe: vi.fn(async () => true), provider, useVenv: true }),
  );
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

test("normalizeConfiguredExecutable(): resolves a relative path against the workspace root", () => {
  // `: any` (not `as any`): minimal fake vscode.WorkspaceFolder/TextDocument for this test.
  const workspaceFolder: any = {
    uri: { fsPath: "/workspace", scheme: "file" },
  };
  vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(
    workspaceFolder,
  );
  const document: any = { uri: {} };

  const result = normalizeConfiguredExecutable("./bin/djlint", document);

  expect(result).toBe(path.resolve("/workspace", "./bin/djlint"));
});

test("normalizeConfiguredExecutable(): leaves a bare command name (no path separator) untouched", () => {
  // `: any` (not `as any`): minimal fake vscode.TextDocument for this test.
  const document: any = { uri: {} };

  const result = normalizeConfiguredExecutable("djlint", document);

  expect(result).toBe("djlint");
  expect(vscode.workspace.getWorkspaceFolder).not.toHaveBeenCalled();
});

test("normalizeConfiguredExecutable(): trims whitespace-only input down to an empty string", () => {
  // `: any` (not `as any`): minimal fake vscode.TextDocument for this test.
  const document: any = { uri: {} };

  expect(normalizeConfiguredExecutable(" ".repeat(3), document)).toBe("");
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

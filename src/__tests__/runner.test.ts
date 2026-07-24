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
  RESOLUTION_TTL_MS,
} = await import("../runner.js");
const { selectSupportedArgs } = await import("../version.js");
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
    probe: vi.fn(async () => null),
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
  const probe = vi.fn(async (exec: string) =>
    exec === "/custom/djlint" ? "1.42.3" : null,
  );
  const command = await resolveDjlintCommand(
    deps({
      executablePath: "/custom/djlint",
      probe,
      provider,
      pythonPath: "/some/python",
    }),
  );
  expect(command).toEqual({
    exec: "/custom/djlint",
    prefixArgs: [],
    version: "1.42.3",
  });
  expect(probe).toHaveBeenCalledWith("/custom/djlint", []);
  // Later steps must never be consulted: step 1 already won.
  expect(provider.getActiveEnvironment).not.toHaveBeenCalled();
});

test("djlint.executablePath: falls through to djlint.pythonPath when it fails to probe", async () => {
  const probe = vi.fn(async (exec: string, prefixArgs: readonly string[]) =>
    exec === "/venv/bin/python" &&
    prefixArgs.length === 2 &&
    prefixArgs[0] === "-m" &&
    prefixArgs[1] === "djlint"
      ? "1.42.3"
      : null,
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
    version: "1.42.3",
  });
});

test("djlint.executablePath: a candidate that launches but has no djLint installed (probe reports no version) falls through, not just an unlaunchable one", async () => {
  // Regression coverage for the gap the version-detecting probe closes: the
  // old permissive probe accepted "the process could be spawned at all",
  // so a valid Python with no djLint installed passed and only failed later
  // at run time. Now probe() itself must report a version.
  const probe = vi.fn(async (exec: string) =>
    exec === "/venv/bin/python" ? "1.0.0" : null,
  );
  const command = await resolveDjlintCommand(
    deps({
      executablePath: "/valid/python/no-djlint",
      probe,
      pythonPath: "/venv/bin/python",
    }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
    version: "1.0.0",
  });
  expect(probe).toHaveBeenCalledWith("/valid/python/no-djlint", []);
});

test("djlint.pythonPath: used (with -m djlint) when no executablePath is set", async () => {
  const probe = vi.fn(async (exec: string) =>
    exec === "/venv/bin/python" ? "1.42.3" : null,
  );
  const command = await resolveDjlintCommand(
    deps({ probe, pythonPath: "/venv/bin/python" }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
    version: "1.42.3",
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
      probe: vi.fn(async () => "1.42.3"),
      provider,
      pythonPath: "/venv/bin/python",
    }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
    version: "1.42.3",
  });
  expect(provider.getActiveEnvironment).not.toHaveBeenCalled();
});

test("active environment: used with its args + -m djlint when neither executablePath nor pythonPath resolve", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: ["run"], executable: "/active/python" }),
    ),
  });
  const probe = vi.fn(async (exec: string) =>
    exec === "/active/python" ? "1.42.3" : null,
  );
  const command = await resolveDjlintCommand(deps({ probe, provider }));
  expect(command).toEqual({
    exec: "/active/python",
    prefixArgs: ["run", "-m", "djlint"],
    version: "1.42.3",
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
    deps({ probe: vi.fn(async () => "1.42.3"), provider }),
  );
  expect(command).toEqual({
    exec: "/usr/bin/uv",
    prefixArgs: ["run", "-p", "3.12", "-m", "djlint"],
    version: "1.42.3",
  });
});

test("active environment: a command that fails to probe falls through to the PATH fallback", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: [], executable: "/active/python" }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({
      probe: vi.fn(async (exec: string) =>
        exec === "djlint" ? "1.42.3" : null,
      ),
      provider,
    }),
  );
  expect(command).toEqual({
    exec: "djlint",
    prefixArgs: [],
    version: "1.42.3",
  });
});

test("active environment with no command falls through to the PATH fallback", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () => envDetails(null)),
  });
  const command = await resolveDjlintCommand(
    deps({ probe: vi.fn(async () => "1.42.3"), provider }),
  );
  expect(command).toEqual({
    exec: "djlint",
    prefixArgs: [],
    version: "1.42.3",
  });
});

test("djlint.useVenv: false skips the active-environment step", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () => {
      throw new Error("should not be reached: useVenv is false");
    }),
  });
  const command = await resolveDjlintCommand(
    deps({ probe: vi.fn(async () => "1.42.3"), provider, useVenv: false }),
  );
  expect(command).toEqual({
    exec: "djlint",
    prefixArgs: [],
    version: "1.42.3",
  });
  expect(provider.getActiveEnvironment).not.toHaveBeenCalled();
});

test("djlint.useVenv left at its default (true) still consults the active environment", async () => {
  const provider = fakeProvider({
    getActiveEnvironment: vi.fn(async () =>
      envDetails({ args: [], executable: "/active/python" }),
    ),
  });
  const command = await resolveDjlintCommand(
    deps({ probe: vi.fn(async () => "1.42.3"), provider, useVenv: true }),
  );
  expect(command).toEqual({
    exec: "/active/python",
    prefixArgs: ["-m", "djlint"],
    version: "1.42.3",
  });
});

test("falls back to djlint on PATH when nothing else resolves", async () => {
  const command = await resolveDjlintCommand(
    deps({
      probe: vi.fn(async (exec: string) =>
        exec === "djlint" ? "1.42.3" : null,
      ),
    }),
  );
  expect(command).toEqual({
    exec: "djlint",
    prefixArgs: [],
    version: "1.42.3",
  });
});

test("throws DjlintUnavailableError when nothing resolves at all", async () => {
  await expect(
    resolveDjlintCommand(deps({ probe: vi.fn(async () => null) })),
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
  const probe = vi.fn(async (exec: string) =>
    exec === "djlint" ? "1.42.3" : null,
  );
  const d = deps({ probe });

  const first = await resolveDjlintCommandCached(d, "scope-a");
  const second = await resolveDjlintCommandCached(d, "scope-a");

  expect(first).toEqual({ exec: "djlint", prefixArgs: [], version: "1.42.3" });
  expect(second).toEqual(first);
  expect(probe).toHaveBeenCalledTimes(1);
});

test("resolveDjlintCommandCached: invalidateDjlintCommandCache() forces a re-probe", async () => {
  const probe = vi.fn(async (exec: string) =>
    exec === "djlint" ? "1.42.3" : null,
  );
  const d = deps({ probe });

  await resolveDjlintCommandCached(d, "scope-a");
  invalidateDjlintCommandCache();
  await resolveDjlintCommandCached(d, "scope-a");

  expect(probe).toHaveBeenCalledTimes(2);
});

test("resolveDjlintCommandCached: different scopes are cached independently", async () => {
  const probe = vi.fn(async (exec: string) =>
    exec === "djlint" ? "1.42.3" : null,
  );
  const d = deps({ probe });

  await resolveDjlintCommandCached(d, "scope-a");
  await resolveDjlintCommandCached(d, "scope-b");
  // undefined is the shared global scope, distinct from either named scope.
  await resolveDjlintCommandCached(d, undefined);

  expect(probe).toHaveBeenCalledTimes(3);
});

test("resolveDjlintCommandCached: a failed resolution is not cached", async () => {
  const probe = vi.fn(async () => null);
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

test("resolveDjlintCommandCached: a cache entry younger than RESOLUTION_TTL_MS is reused", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    const probe = vi.fn(async (exec: string) =>
      exec === "djlint" ? "1.42.3" : null,
    );
    const d = deps({ probe });

    await resolveDjlintCommandCached(d, "scope-a");
    vi.setSystemTime(RESOLUTION_TTL_MS - 1);
    await resolveDjlintCommandCached(d, "scope-a");

    expect(probe).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("resolveDjlintCommandCached: a cache entry at least RESOLUTION_TTL_MS old is treated as a miss and re-probed (picks up an in-place djLint upgrade)", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    const probe = vi.fn(async (exec: string): Promise<string | null> =>
      exec === "djlint" ? "1.42.3" : null,
    );
    const d = deps({ probe });

    const first = await resolveDjlintCommandCached(d, "scope-a");
    expect(first.version).toBe("1.42.3");

    vi.setSystemTime(RESOLUTION_TTL_MS);
    probe.mockImplementation(async (exec: string) =>
      exec === "djlint" ? "1.43.0" : null,
    );
    const second = await resolveDjlintCommandCached(d, "scope-a");

    expect(probe).toHaveBeenCalledTimes(2);
    expect(second.version).toBe("1.43.0");
  } finally {
    vi.useRealTimers();
  }
});

function fakeArg(over: {
  cliName: string;
  minVersion: string;
  vscodeName?: string;
}): any {
  return { vscodeName: "", ...over };
}

function fakeOutputChannel(): any {
  return { warn: vi.fn() };
}

test("selectSupportedArgs: keeps every arg whose minVersion the resolved version satisfies", () => {
  const outputChannel = fakeOutputChannel();
  const args = [
    fakeArg({ cliName: "--a", minVersion: "1.0" }),
    fakeArg({ cliName: "--b", minVersion: "1.42" }),
  ];

  const result = selectSupportedArgs(args, "1.42.3", outputChannel);

  expect(result).toEqual(args);
  expect(outputChannel.warn).not.toHaveBeenCalled();
});

test("selectSupportedArgs: drops an arg whose minVersion is newer than the resolved version, and warns once", () => {
  const outputChannel = fakeOutputChannel();
  const supported = fakeArg({ cliName: "--old", minVersion: "1.0" });
  const unsupported = fakeArg({
    cliName: "--stdin-filename",
    minVersion: "1.43.0",
  });

  const result = selectSupportedArgs(
    [supported, unsupported],
    "1.42.3",
    outputChannel,
  );

  expect(result).toEqual([supported]);
  expect(outputChannel.warn).toHaveBeenCalledTimes(1);
  const [[message]] = outputChannel.warn.mock.calls;
  expect(message).toContain("--stdin-filename");
  expect(message).toContain("1.43.0");
});

test("selectSupportedArgs: names the djlint.* setting (not just the CLI flag) when the arg has a vscodeName", () => {
  const outputChannel = fakeOutputChannel();
  const arg = fakeArg({
    cliName: "--rules",
    minVersion: "1.41",
    vscodeName: "rules",
  });

  selectSupportedArgs([arg], "1.0", outputChannel);

  const [[message]] = outputChannel.warn.mock.calls;
  expect(message).toContain("djlint.rules");
});

// Regression coverage for the resolved-command cache (RESOLUTION_TTL_MS in
// runner.ts) making runDjlintCommand() call selectSupportedArgs() with the
// same version on every save/lint while the cache is warm: without dedupe,
// the same "Skipping ..." warning would be logged again on every one of
// those calls instead of once per resolved version.
test("selectSupportedArgs: warns only once per resolved version across repeated calls (warm-cache simulation)", () => {
  const outputChannel = fakeOutputChannel();
  const unsupported = fakeArg({
    cliName: "--stdin-filename",
    minVersion: "1.43.0",
  });

  // Simulates runDjlintCommand() being invoked 3 times (e.g. 3 saves) while
  // resolveDjlintCommandCached() keeps returning the same cached "1.42.3".
  selectSupportedArgs([unsupported], "1.42.3", outputChannel);
  selectSupportedArgs([unsupported], "1.42.3", outputChannel);
  selectSupportedArgs([unsupported], "1.42.3", outputChannel);

  expect(outputChannel.warn).toHaveBeenCalledTimes(1);
});

test("selectSupportedArgs: a different skipped option for the same version still warns separately", () => {
  const outputChannel = fakeOutputChannel();
  const first = fakeArg({ cliName: "--stdin-filename", minVersion: "1.43.0" });
  const second = fakeArg({ cliName: "--rules", minVersion: "1.41" });

  selectSupportedArgs([first], "1.0", outputChannel);
  selectSupportedArgs([second], "1.0", outputChannel);

  expect(outputChannel.warn).toHaveBeenCalledTimes(2);
});

test("selectSupportedArgs: invalidateDjlintCommandCache() lets a previously-warned (version, arg) pair warn again", () => {
  const outputChannel = fakeOutputChannel();
  const unsupported = fakeArg({
    cliName: "--stdin-filename",
    minVersion: "1.43.0",
  });

  selectSupportedArgs([unsupported], "1.42.3", outputChannel);
  invalidateDjlintCommandCache();
  selectSupportedArgs([unsupported], "1.42.3", outputChannel);

  expect(outputChannel.warn).toHaveBeenCalledTimes(2);
});

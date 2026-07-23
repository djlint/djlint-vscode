import { expect, test, vi } from "vitest";
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
}));

const { resolveDjlintCommand } = await import("../runner.js");
const { DjlintUnavailableError } = await import("../engine/types.js");
type ResolveDjlintCommandDeps = Parameters<typeof resolveDjlintCommand>[0];

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

test("deprecated djlint.executablePath is honored only when explicitly changed from the old default", async () => {
  const probe = vi.fn(async () => true);

  const defaulted = await resolveDjlintCommand(
    deps({ executablePath: "djlint", probe }),
  );
  // Still falls through to the PATH fallback ("djlint"), not treated as an explicit setting.
  expect(defaulted).toEqual({ exec: "djlint", prefixArgs: [] });

  const explicit = await resolveDjlintCommand(
    deps({ executablePath: "/custom/djlint", probe }),
  );
  expect(explicit).toEqual({ exec: "/custom/djlint", prefixArgs: [] });
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
    deps({ interpreter: ["/venv/bin/python"], provider }),
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
    deps({ interpreter: ["uv"], provider }),
  );
  expect(command).toEqual({
    exec: "/usr/bin/uv",
    prefixArgs: ["run", "-p", "3.12", "-m", "djlint"],
  });
});

test("djlint.interpreter: falls back to the raw entry when the provider is null", async () => {
  const command = await resolveDjlintCommand(
    deps({ interpreter: ["/venv/bin/python"], provider: null }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
    prefixArgs: ["-m", "djlint"],
  });
});

test("djlint.interpreter: falls back to the raw entry when the provider cannot resolve it", async () => {
  const provider = fakeProvider({
    resolveInterpreter: vi.fn(async () => null),
  });
  const command = await resolveDjlintCommand(
    deps({ interpreter: ["/venv/bin/python"], provider }),
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
    deps({ interpreter: ["  ", "/venv/bin/python"], provider }),
  );
  expect(command).toEqual({
    exec: "/venv/bin/python",
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

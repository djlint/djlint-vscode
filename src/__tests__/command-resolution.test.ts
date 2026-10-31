// Which djLint actually runs: executablePath > pythonPath > active environment
// > `djlint` on PATH > `python3 -m djlint` > `python -m djlint`.
import { describe, expect, it } from "vitest";
import {
  resolveDjlintCommand,
  type ResolveDjlintCommandDeps,
} from "../engine/subprocess/resolve.js";
import { DjlintUnavailableError } from "../engine/types.js";

/** `works` lists the exec names with a real djLint; everything else fails. */
function makeDeps(
  overrides: Partial<ResolveDjlintCommandDeps>,
  works: readonly string[],
): { deps: ResolveDjlintCommandDeps; probed: string[]; rejected: string[] } {
  const probed: string[] = [];
  const rejected: string[] = [];
  const deps: ResolveDjlintCommandDeps = {
    executablePath: "",
    getActiveEnvironment: async () => null,
    onConfiguredPathRejected: (setting, exec) => {
      rejected.push(`${setting}:${exec}`);
    },
    probe: async (exec, prefixArgs) => {
      probed.push([exec, ...prefixArgs].join(" "));
      return works.includes(exec) ? "1.44.2" : null;
    },
    pythonPath: "",
    uri: void 0,
    ...overrides,
  };
  return { deps, probed, rejected };
}

const condaEnvironment = {
  command: { args: ["run", "-p", "/env"], executable: "conda" },
};

describe("resolveDjlintCommand", () => {
  it("takes executablePath outright, probing nothing else", async () => {
    const { deps, probed } = makeDeps({ executablePath: "/bin/djlint" }, [
      "/bin/djlint",
    ]);
    await expect(resolveDjlintCommand(deps)).resolves.toStrictEqual({
      exec: "/bin/djlint",
      prefixArgs: [],
      version: "1.44.2",
    });
    expect(probed).toStrictEqual(["/bin/djlint"]);
  });

  it("falls through a broken executablePath and reports it", async () => {
    const { deps, probed, rejected } = makeDeps(
      { executablePath: "/typo/djlint", pythonPath: "/py" },
      ["/py"],
    );
    await expect(resolveDjlintCommand(deps)).resolves.toStrictEqual({
      exec: "/py",
      prefixArgs: ["-m", "djlint"],
      version: "1.44.2",
    });
    expect(rejected).toStrictEqual(["executablePath:/typo/djlint"]);
    expect(probed).toStrictEqual(["/typo/djlint", "/py -m djlint"]);
  });

  it("keeps an environment's launch args ahead of `-m djlint`", async () => {
    const { deps, probed } = makeDeps(
      { getActiveEnvironment: async () => condaEnvironment },
      ["conda"],
    );
    await expect(resolveDjlintCommand(deps)).resolves.toStrictEqual({
      exec: "conda",
      prefixArgs: ["run", "-p", "/env", "-m", "djlint"],
      version: "1.44.2",
    });
    expect(probed).toStrictEqual(["conda run -p /env -m djlint"]);
  });

  it("skips the environment entirely without a lookup (useVenv off)", async () => {
    const { deps, probed } = makeDeps({ getActiveEnvironment: null }, [
      "djlint",
    ]);
    await expect(resolveDjlintCommand(deps)).resolves.toStrictEqual({
      exec: "djlint",
      prefixArgs: [],
      version: "1.44.2",
    });
    expect(probed).toStrictEqual(["djlint"]);
  });

  it("skips an environment with no runnable command", async () => {
    const { deps } = makeDeps(
      { getActiveEnvironment: async () => ({ command: null }) },
      ["djlint"],
    );
    await expect(resolveDjlintCommand(deps)).resolves.toMatchObject({
      exec: "djlint",
    });
  });

  it("does not accept an interpreter without djLint", async () => {
    const { deps, probed } = makeDeps({ pythonPath: "/py-no-djlint" }, [
      "djlint",
    ]);
    await expect(resolveDjlintCommand(deps)).resolves.toMatchObject({
      exec: "djlint",
    });
    expect(probed).toStrictEqual(["/py-no-djlint -m djlint", "djlint"]);
  });

  it("does not report an environment that lacks djLint as misconfigured", async () => {
    const { deps, rejected } = makeDeps(
      { getActiveEnvironment: async () => condaEnvironment },
      ["djlint"],
    );
    await resolveDjlintCommand(deps);
    expect(rejected).toStrictEqual([]);
  });

  it("ignores whitespace around the configured paths", async () => {
    const { deps, probed } = makeDeps(
      { executablePath: "   ", pythonPath: "  /py  " },
      ["/py"],
    );
    await resolveDjlintCommand(deps);
    expect(probed).toStrictEqual(["/py -m djlint"]);
  });

  it("probes every candidate in order before giving up", async () => {
    const { deps, probed, rejected } = makeDeps(
      {
        executablePath: "/a",
        getActiveEnvironment: async () => condaEnvironment,
        pythonPath: "/b",
      },
      [],
    );
    await expect(resolveDjlintCommand(deps)).rejects.toBeInstanceOf(
      DjlintUnavailableError,
    );
    expect(probed).toStrictEqual([
      "/a",
      "/b -m djlint",
      "conda run -p /env -m djlint",
      "djlint",
      "python3 -m djlint",
      "python -m djlint",
    ]);
    expect(rejected).toStrictEqual(["executablePath:/a", "pythonPath:/b"]);
  });

  it.each([
    ["python3", ["-m", "djlint"]],
    ["python", ["-m", "djlint"]],
  ])("reaches %s when nothing before it works", async (exec, prefixArgs) => {
    const { deps } = makeDeps({}, [exec]);
    await expect(resolveDjlintCommand(deps)).resolves.toStrictEqual({
      exec,
      prefixArgs,
      version: "1.44.2",
    });
  });

  it("prefers python3 over python", async () => {
    const { deps, probed } = makeDeps({}, ["python3", "python"]);
    await expect(resolveDjlintCommand(deps)).resolves.toMatchObject({
      exec: "python3",
    });
    expect(probed).toStrictEqual(["djlint", "python3 -m djlint"]);
  });

  it("prefers `djlint` on PATH over a python on PATH", async () => {
    const { deps } = makeDeps({}, ["python3", "djlint"]);
    await expect(resolveDjlintCommand(deps)).resolves.toMatchObject({
      exec: "djlint",
    });
  });
});

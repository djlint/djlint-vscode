// SubprocessEngine with execa replaced: what it spawns, and how it classifies
// each way a spawned djLint can end.
import { existsSync } from "node:fs";
import { execa } from "execa";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  formattingOptions,
  liveToken,
  makeChannel,
  makeConfig,
  makeDocument,
  makeExecaError,
  setWorkspaceFolders,
} from "../../__tests__/helpers.js";
import { control, resetVscode, Uri } from "../../__tests__/vscode-stub.js";
import type { PythonEnvironments } from "../../python/environment.js";
import { SubprocessEngine } from "../subprocess/index.js";
import { LINTER_OUTPUT_FORMAT } from "../subprocess/parse-lint-output.js";
import {
  DjlintUnavailableError,
  RESOLUTION_TTL_MS,
  RUN_TIMEOUT_MS,
} from "../types.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => true),
}));

vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: vi.fn(),
}));

type Spawn = (
  exec: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => Promise<{ exitCode?: number; stdout: string }>;

const spawn = execa as unknown as Mock<Spawn>;

const VERSION_OUTPUT = { exitCode: 0, stdout: "djlint, version 1.44.2" };

function isProbe(args: readonly string[]): boolean {
  return args.includes("--version");
}

/** A djLint that answers `--version` and leaves the run to `run`. */
function installDjlint(
  run: Spawn = async () => ({ stdout: "" }),
  version = VERSION_OUTPUT,
): void {
  spawn.mockImplementation(async (exec, args, options) =>
    isProbe(args) ? version : run(exec, args, options),
  );
}

function probes(): number {
  return spawn.mock.calls.filter(([, args]) => isProbe(args)).length;
}

function runs(): Parameters<Spawn>[] {
  return spawn.mock.calls.filter(([, args]) => !isProbe(args));
}

const document = makeDocument("/w/sub/t.html", "<p>x</p>");
const config = makeConfig({ executablePath: "/bin/djlint" });

function makeEngine(
  getActive: PythonEnvironments["getActive"] = async () => null,
): { channel: ReturnType<typeof makeChannel>; engine: SubprocessEngine } {
  const channel = makeChannel();
  return {
    channel,
    engine: new SubprocessEngine(channel, {
      getActive,
    } as unknown as PythonEnvironments),
  };
}

beforeEach(() => {
  resetVscode();
  spawn.mockReset();
  setWorkspaceFolders("/w");
});

describe("the spawned command", () => {
  it("feeds the document to `djlint -` beside the document", async () => {
    installDjlint(async () => ({ stdout: "FORMATTED" }));
    const { engine } = makeEngine();
    await expect(
      engine.format(document, config, formattingOptions, liveToken()),
    ).resolves.toBe("FORMATTED");

    const [[exec, args, options]] = runs() as [Parameters<Spawn>];
    expect(exec).toBe("/bin/djlint");
    expect(args.slice(0, 1)).toStrictEqual(["-"]);
    expect(args).toContain("--reformat");
    expect(args).toContain("--quiet");
    expect(options).toMatchObject({
      cwd: Uri.file("/w/sub").fsPath,
      input: "<p>x</p>",
      stripFinalNewline: false,
      timeout: RUN_TIMEOUT_MS,
    });
  });

  it("runs a python with its module args ahead of `-`", async () => {
    installDjlint();
    const { engine } = makeEngine();
    await engine.format(
      document,
      makeConfig({ pythonPath: "/py" }),
      formattingOptions,
      liveToken(),
    );
    const [[exec, args]] = runs() as [Parameters<Spawn>];
    expect(exec).toBe("/py");
    expect(args.slice(0, 3)).toStrictEqual(["-m", "djlint", "-"]);
  });

  it("probes from the document's folder, without feeding it stdin", async () => {
    installDjlint();
    const { engine } = makeEngine();
    await engine.format(document, config, formattingOptions, liveToken());
    expect(spawn.mock.calls[0]).toMatchObject([
      "/bin/djlint",
      ["--version"],
      { cwd: Uri.file("/w/sub").fsPath, reject: false, stdin: "ignore" },
    ]);
  });

  it("uses the lint arguments for a lint", async () => {
    installDjlint();
    const { engine } = makeEngine();
    await engine.lint(document, config, liveToken());
    const [[, args]] = runs() as [Parameters<Spawn>];
    expect(args).not.toContain("--reformat");
    expect(args).toContain("--linter-output-format");
    expect(args).toContain(LINTER_OUTPUT_FORMAT);
    expect(args).toContain("--stdin-filename");
    expect(args).toContain("sub/t.html");
  });

  it("leaves out flags the resolved djLint is too old for, warning once", async () => {
    installDjlint(void 0, { exitCode: 0, stdout: "djlint, version 1.25" });
    const { channel, engine } = makeEngine();
    const old = makeConfig({
      executablePath: "/bin/djlint",
      formatCss: true,
      maxBlankLines: 2,
    });
    await engine.format(document, old, formattingOptions, liveToken());
    await engine.format(document, old, formattingOptions, liveToken());

    for (const [, args] of runs()) {
      expect(args).toContain("--format-css");
      expect(args).not.toContain("--max-blank-lines");
    }
    expect(
      channel.of("warn").filter((line) => line.includes("maxBlankLines")),
    ).toHaveLength(1);
  });

  it("runs from no folder when the document's folder is gone, instead of taking the ENOENT for a missing djLint", async () => {
    installDjlint();
    vi.mocked(existsSync).mockReturnValueOnce(false).mockReturnValueOnce(false);
    const { engine } = makeEngine();
    await engine.format(document, config, formattingOptions, liveToken());

    expect(runs().map(([, , childOptions]) => childOptions)).toEqual([
      expect.not.objectContaining({ cwd: expect.anything() }),
    ]);
  });

  it("has no folder to run from for a virtual document, warning once per scheme", async () => {
    installDjlint();
    const { channel, engine } = makeEngine();
    const virtual = makeDocument(
      vscode.Uri.parse("vscode-vfs://github/o/r/t.html"),
    );
    await engine.format(virtual, config, formattingOptions, liveToken());
    await engine.format(virtual, config, formattingOptions, liveToken());

    const options = runs().map(([, , childOptions]) => childOptions);
    expect(options.every((option) => !("cwd" in option))).toBe(true);
    expect(
      channel.of("warn").filter((line) => line.includes("vscode-vfs:")),
    ).toHaveLength(1);
  });
});

describe("resolution through the engine", () => {
  it('logs "Using djLint <version>: <command>" once per change', async () => {
    installDjlint();
    const { channel, engine } = makeEngine();
    await engine.format(document, config, formattingOptions, liveToken());
    await engine.lint(document, config, liveToken());
    expect(channel.of("info")).toStrictEqual([
      "Using djLint 1.44.2: /bin/djlint",
    ]);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.advanceTimersByTime(RESOLUTION_TTL_MS + 1);
      await engine.lint(
        document,
        makeConfig({ pythonPath: "/py" }),
        liveToken(),
      );
    } finally {
      vi.useRealTimers();
    }
    expect(channel.of("info")).toStrictEqual([
      "Using djLint 1.44.2: /bin/djlint",
      "Using djLint 1.44.2: /py -m djlint",
    ]);
  });

  it("logs each workspace folder's djLint", async () => {
    setWorkspaceFolders("/w", "/v");
    installDjlint();
    const { channel, engine } = makeEngine();
    await engine.lint(document, config, liveToken());
    await engine.lint(makeDocument("/v/t.html"), config, liveToken());
    expect(channel.of("info")).toHaveLength(2);
  });

  it("does not probe again for a second run", async () => {
    installDjlint();
    const { engine } = makeEngine();
    await engine.lint(document, config, liveToken());
    await engine.lint(document, config, liveToken());
    expect(probes()).toBe(1);
  });

  it("warns about a configured path with no working djLint", async () => {
    spawn.mockImplementation(async (exec, args) =>
      exec === "djlint" && isProbe(args)
        ? VERSION_OUTPUT
        : isProbe(args)
          ? { exitCode: 1, stdout: "" }
          : { stdout: "" },
    );
    const { channel, engine } = makeEngine();
    await engine.lint(document, config, liveToken());
    expect(channel.of("warn")[0]).toContain(
      'djlint.executablePath is set to "/bin/djlint"',
    );
  });

  it("resolves a relative configured path from the workspace root", async () => {
    installDjlint();
    const { engine } = makeEngine();
    await engine.lint(
      document,
      makeConfig({ executablePath: "./bin/djlint" }),
      liveToken(),
    );
    const [exec] = spawn.mock.calls[0] ?? [];
    expect(String(exec).replaceAll("\\", "/")).toMatch(/\/w\/bin\/djlint$/u);
  });

  it("treats a probe that cannot spawn as no djLint", async () => {
    spawn.mockRejectedValue(new Error("spawn failed"));
    const { engine } = makeEngine();
    await expect(
      engine.lint(document, config, liveToken()),
    ).rejects.toBeInstanceOf(DjlintUnavailableError);
  });

  it("treats a probe that answers garbage as no djLint", async () => {
    installDjlint(void 0, { exitCode: 0, stdout: "not djlint" });
    const { engine } = makeEngine();
    await expect(
      engine.lint(document, config, liveToken()),
    ).rejects.toBeInstanceOf(DjlintUnavailableError);
  });

  it("asks for the active environment of the document with useVenv on", async () => {
    installDjlint();
    const getActive = vi.fn(async () => ({
      command: { args: [], executable: "/venv/python" },
    }));
    const { engine } = makeEngine(getActive);
    await engine.lint(document, makeConfig({ useVenv: true }), liveToken());
    expect(getActive).toHaveBeenCalledExactlyOnceWith(document.uri);
    const [[exec, args]] = runs() as [Parameters<Spawn>];
    expect(exec).toBe("/venv/python");
    expect(args.slice(0, 3)).toStrictEqual(["-m", "djlint", "-"]);
  });

  it("never asks for an environment with useVenv off", async () => {
    installDjlint();
    const getActive = vi.fn(async () => null);
    const { engine } = makeEngine(getActive);
    await engine.lint(document, makeConfig({ useVenv: false }), liveToken());
    expect(getActive).not.toHaveBeenCalled();
    const [[exec]] = runs() as [Parameters<Spawn>];
    expect(exec).toBe("djlint");
  });
});

describe("how a run ends", () => {
  const FS = "\u{1F}";
  const RS = "\u{1E}";

  it("parses findings from a clean exit", async () => {
    installDjlint(async () => ({ stdout: `H013${FS}1:5${FS}msg${RS}\n` }));
    const { engine } = makeEngine();
    await expect(
      engine.lint(document, config, liveToken()),
    ).resolves.toStrictEqual([
      { code: "H013", column: 5, line: 1, message: "msg" },
    ]);
  });

  it("reads exit 1 from a lint as its findings, not a failure", async () => {
    installDjlint(async () => {
      throw makeExecaError({
        exitCode: 1,
        stdout: `H013${FS}1:5${FS}msg${RS}\n`,
      });
    });
    const { engine } = makeEngine();
    await expect(
      engine.lint(document, config, liveToken()),
    ).resolves.toHaveLength(1);
    expect(control.shownErrors).toStrictEqual([]);
    expect(probes()).toBe(1);
  });

  it("reports a genuine failure and rethrows it", async () => {
    const error = makeExecaError({
      exitCode: 2,
      stderr: "Traceback\nValueError: bad\n",
    });
    installDjlint(async () => {
      throw error;
    });
    const { channel, engine } = makeEngine();
    await expect(
      engine.format(document, config, formattingOptions, liveToken()),
    ).rejects.toBe(error);
    expect(control.shownErrors).toStrictEqual([
      "djLint failed: ValueError: bad",
    ]);
    expect(channel.of("error")).toHaveLength(1);
  });

  it("treats a djLint that vanished as unavailable and forgets it", async () => {
    const vanished = makeExecaError({ code: "ENOENT" });
    installDjlint(async () => {
      throw vanished;
    });
    const { engine } = makeEngine();
    const failure = engine.format(
      document,
      config,
      formattingOptions,
      liveToken(),
    );
    await expect(failure).rejects.toBeInstanceOf(DjlintUnavailableError);
    await expect(failure).rejects.toMatchObject({ cause: vanished });
    expect(control.shownErrors).toStrictEqual([]);
    expect(runs()).toHaveLength(2);

    await expect(
      engine.format(document, config, formattingOptions, liveToken()),
    ).rejects.toBeInstanceOf(DjlintUnavailableError);
    expect(runs()).toHaveLength(4);
  });

  it("looks for djLint again when the one it had vanished", async () => {
    let isFirstRun = true;
    installDjlint(async () => {
      if (isFirstRun) {
        isFirstRun = false;
        throw makeExecaError({ code: "ENOENT" });
      }
      return { stdout: "FORMATTED" };
    });
    const { engine } = makeEngine();
    await expect(
      engine.format(document, config, formattingOptions, liveToken()),
    ).resolves.toBe("FORMATTED");
    expect(probes()).toBe(2);
  });

  it("treats a failure djLint no longer answers probes after as unavailable", async () => {
    let firstProbe = true;
    spawn.mockImplementation(async (_exec, args) => {
      if (!isProbe(args)) {
        throw makeExecaError({ exitCode: 3, stderr: "gone" });
      }
      const output = firstProbe ? VERSION_OUTPUT : { exitCode: 1, stdout: "" };
      firstProbe = false;
      return output;
    });
    const { engine } = makeEngine();
    await expect(
      engine.format(document, config, formattingOptions, liveToken()),
    ).rejects.toBeInstanceOf(DjlintUnavailableError);
    expect(control.shownErrors).toStrictEqual([]);
  });

  it("does not report a cancellation", async () => {
    const cancelled = makeExecaError({ isCanceled: true });
    installDjlint(async () => {
      throw cancelled;
    });
    const { engine } = makeEngine();
    await expect(
      engine.format(document, config, formattingOptions, liveToken()),
    ).rejects.toBe(cancelled);
    expect(control.shownErrors).toStrictEqual([]);
    expect(probes()).toBe(1);
  });

  it("passes other errors through untouched", async () => {
    const error = new TypeError("not from execa");
    installDjlint(async () => {
      throw error;
    });
    const { engine } = makeEngine();
    await expect(
      engine.format(document, config, formattingOptions, liveToken()),
    ).rejects.toBe(error);
  });
});

describe("cancellation", () => {
  function abortable(): Spawn {
    return async (_exec, _args, options) => {
      const signal = options["cancelSignal"] as AbortSignal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(makeExecaError({ isCanceled: true }));
        });
      });
    };
  }

  it("aborts the child when the token fires", async () => {
    installDjlint(abortable());
    const { engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    const pending = engine.format(
      document,
      config,
      formattingOptions,
      source.token,
    );
    await vi.waitFor(() => {
      expect(runs()).toHaveLength(1);
    });
    source.cancel();
    await expect(pending).rejects.toMatchObject({ isCanceled: true });
  });

  it("spawns nothing when the token fired during resolution", async () => {
    installDjlint();
    const { engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    await expect(
      engine.format(document, config, formattingOptions, source.token),
    ).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(runs()).toHaveLength(0);
  });
});

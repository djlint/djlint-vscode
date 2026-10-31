// Logic that other suites only exercise indirectly: the per-document
// cancellation bookkeeping shared by Formatter and Linter, the version gate
// that decides which flags an older djLint is sent, and how a wedged run is
// classified.
import { execa } from "execa";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { formattingArgs } from "../args.js";
import { CancellationRegistry } from "../cancellation-registry.js";
import { isValidLintResult } from "../engine/subprocess/errors.js";
import {
  isDjlintUnavailable,
  type CustomExecaError,
} from "../engine/subprocess/exec.js";
import { classifyRunFailure } from "../engine/subprocess/index.js";
import { selectSupportedArgs } from "../engine/subprocess/version.js";
import {
  makeChannel,
  makeConfig,
  makeDocument,
  makeExecaError,
} from "./helpers.js";
import { resetVscode } from "./vscode-stub.js";

beforeEach(() => {
  resetVscode();
});

describe("CancellationRegistry", () => {
  it("registers a fresh run uncancelled", () => {
    const registry = new CancellationRegistry();
    const run = registry.start("doc");
    expect(registry.has("doc")).toBe(true);
    expect(run.token.isCancellationRequested).toBe(false);
  });

  it("cancels the run a new one supersedes", () => {
    const registry = new CancellationRegistry();
    const first = registry.start("doc");
    const second = registry.start("doc");
    expect(first.token.isCancellationRequested).toBe(true);
    expect(second.token.isCancellationRequested).toBe(false);
  });

  it("does not let the loser's finish evict the winner", () => {
    const registry = new CancellationRegistry();
    const first = registry.start("doc");
    const second = registry.start("doc");
    registry.finish("doc", first);
    expect(registry.has("doc")).toBe(true);
    registry.finish("doc", second);
    expect(registry.has("doc")).toBe(false);
  });

  it("keeps scopes independent", () => {
    const registry = new CancellationRegistry();
    const a = registry.start("a");
    registry.start("b");
    expect(a.token.isCancellationRequested).toBe(false);
  });

  it("cancels a closed document without leaving an entry", () => {
    const registry = new CancellationRegistry();
    const run = registry.start("a");
    registry.cancelAndDelete("a");
    expect(run.token.isCancellationRequested).toBe(true);
    expect(registry.has("a")).toBe(false);

    registry.finish("a", run);
    expect(registry.has("a")).toBe(false);
  });

  it("cancels everything on disposal", () => {
    const registry = new CancellationRegistry();
    const run = registry.start("b");
    registry.disposeAll();
    expect(run.token.isCancellationRequested).toBe(true);
    expect(registry.has("b")).toBe(false);
  });
});

describe("selectSupportedArgs", () => {
  // --max-blank-lines needs 1.31; --format-css needs 1.9.
  const args = formattingArgs.filter((arg) =>
    ["--format-css", "--max-blank-lines"].includes(arg.cliName),
  );
  const context = {
    config: makeConfig({ formatCss: true, maxBlankLines: 1 }),
    document: makeDocument("/w/a.html"),
  };

  it("filters out flags too new for the version", () => {
    const supported = selectSupportedArgs(
      args,
      "1.25",
      context,
      new Set(),
      makeChannel(),
    );
    expect(supported.map((arg) => arg.cliName)).toStrictEqual(["--format-css"]);
  });

  it("warns once per version and flag, naming the setting", () => {
    const channel = makeChannel();
    const warned = new Set<string>();
    selectSupportedArgs(args, "1.25", context, warned, channel);
    expect(channel.of("warn")).toHaveLength(1);
    expect(channel.of("warn")[0]).toContain("djlint.maxBlankLines");

    selectSupportedArgs(args, "1.25", context, warned, channel);
    expect(channel.of("warn")).toHaveLength(1);

    selectSupportedArgs(args, "1.20", context, warned, channel);
    expect(channel.of("warn")).toHaveLength(2);
  });

  it("warns again for a fresh engine's empty set", () => {
    const channel = makeChannel();
    selectSupportedArgs(args, "1.25", context, new Set(), channel);
    selectSupportedArgs(args, "1.25", context, new Set(), channel);
    expect(channel.of("warn")).toHaveLength(2);
  });

  it("skips a flag that is not set without a warning", () => {
    const channel = makeChannel();
    const unset = { ...context, config: makeConfig({ formatCss: true }) };
    const supported = selectSupportedArgs(
      args,
      "1.25",
      unset,
      new Set(),
      channel,
    );
    expect(supported.map((arg) => arg.cliName)).toStrictEqual(["--format-css"]);
    expect(channel.of("warn")).toHaveLength(0);
  });

  it("keeps everything for a new enough version", () => {
    const channel = makeChannel();
    expect(
      selectSupportedArgs(args, "1.44.2", context, new Set(), channel),
    ).toHaveLength(2);
    expect(channel.of("warn")).toHaveLength(0);
  });
});

// An unresponsive child is killed by RUN_TIMEOUT_MS rather than hanging
// forever. The resulting error must not be mistaken for either of the two
// benign failures, so this drives a real execa timeout rather than a
// hand-built object: a killed process reports exitCode `undefined`.
describe("a wedged djLint run", () => {
  let timedOut: CustomExecaError & { timedOut: boolean };

  beforeAll(async () => {
    const result = await execa(
      process.execPath,
      ["-e", "process.stdin.resume(); setTimeout(() => {}, 60000);"],
      { input: "<div></div>", reject: false, timeout: 800 },
    );
    timedOut = result as unknown as typeof timedOut;
  });

  it("is reaped, not cancelled", () => {
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.isCanceled).toBe(false);
    expect(timedOut.exitCode).toBeUndefined();
  });

  it("is not mistaken for lint findings or a missing djLint", () => {
    expect(isValidLintResult(timedOut, true)).toBe(false);
    expect(isDjlintUnavailable(timedOut)).toBe(false);
  });

  it("is an error while djLint still works", async () => {
    await expect(
      classifyRunFailure(
        timedOut,
        (e) => isValidLintResult(e, true),
        isDjlintUnavailable,
        async () => "1.44.2",
      ),
    ).resolves.toBe("error");
  });

  it("falls back to the bundled runtime when djLint is gone too", async () => {
    await expect(
      classifyRunFailure(
        timedOut,
        (e) => isValidLintResult(e, true),
        isDjlintUnavailable,
        async () => null,
      ),
    ).resolves.toBe("unavailable");
  });
});

describe("classifyRunFailure", () => {
  it("does not reprobe when the error alone decides", async () => {
    let reprobes = 0;
    const reprobe = async (): Promise<string> => {
      reprobes += 1;
      return "1.44.2";
    };
    const error = makeExecaError({ exitCode: 1 });
    await expect(
      classifyRunFailure(
        error,
        () => true,
        () => false,
        reprobe,
      ),
    ).resolves.toBe("lint-result");
    await expect(
      classifyRunFailure(
        error,
        () => false,
        () => true,
        reprobe,
      ),
    ).resolves.toBe("unavailable");
    expect(reprobes).toBe(0);
  });
});

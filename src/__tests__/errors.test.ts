// checkErrors() must turn djLint rejecting an option into the actionable
// "update djLint" message rather than a bare dump, in every wording click has
// used for that rejection.
import { execa } from "execa";
import { beforeEach, describe, expect, it } from "vitest";
import { checkErrors, isValidLintResult } from "../engine/subprocess/errors.js";
import {
  isDjlintUnavailable,
  type CustomExecaError,
} from "../engine/subprocess/exec.js";
import { makeChannel, makeExecaError } from "./helpers.js";
import { control, resetVscode } from "./vscode-stub.js";

beforeEach(() => {
  resetVscode();
});

function report(error: CustomExecaError): {
  message: string | undefined;
  rethrown: unknown;
} {
  let rethrown: unknown;
  try {
    checkErrors(error, makeChannel());
  } catch (e) {
    rethrown = e;
  }
  return { message: control.shownErrors[0], rethrown };
}

const MODERN =
  "Usage: djlint [OPTIONS] SRC ...\nTry 'djlint --help' for help.\n\nError: No such option '--max-blank-lines-XYZ'. (Did you mean one of: '--blank-line-after-tag', '--max-blank-lines', '--preserve-blank-lines'?)";

describe("checkErrors", () => {
  it("names the setting and the version for the modern click wording", () => {
    const { message } = report(
      makeExecaError({
        exitCode: 2,
        stderr: MODERN.replace("--max-blank-lines-XYZ", "--max-blank-lines"),
      }),
    );
    expect(message).toContain(
      "does not support the `djlint.maxBlankLines` option",
    );
    expect(message).toContain("version 1.31 or newer");
    expect(message).toContain("https://djlint.com/docs/getting-started/");
  });

  it("names the setting for the older click wording", () => {
    const { message } = report(
      makeExecaError({
        exitCode: 2,
        stderr: "Error: No such option: --max-blank-lines",
      }),
    );
    expect(message).toContain("does not support the");
  });

  it("is generic for a flag the extension does not know", () => {
    const { message } = report(makeExecaError({ exitCode: 2, stderr: MODERN }));
    expect(message).not.toContain("does not support the");
    expect(message).toMatch(/^djLint failed: Error: No such option/u);
  });

  it("does not read a verdict into a process that was killed", () => {
    const { message } = report(
      makeExecaError({ stderr: "Error: No such option: --max-blank-lines" }),
    );
    expect(message).not.toContain("does not support the");
  });

  it("says why djLint could not start", () => {
    const { message } = report(makeExecaError({ code: "E2BIG" }));
    expect(message).toBe("djLint could not start: E2BIG.");
  });

  it("summarizes stderr by its last non-empty line", () => {
    const { message } = report(
      makeExecaError({
        exitCode: 1,
        stderr: "Traceback\n  File x\nValueError: bad value\n\n",
      }),
    );
    expect(message).toBe("djLint failed: ValueError: bad value");
  });

  it("falls back to the short message without stderr", () => {
    const { message } = report(
      makeExecaError({
        exitCode: 3,
        shortMessage: "Command failed: djlint - --stdin-filename a.html",
      }),
    );
    expect(message).toBe("djLint failed with exit code 3.");
  });

  it("logs and rethrows the original error", () => {
    const error = makeExecaError({ exitCode: 3, shortMessage: "boom" });
    const channel = makeChannel();
    expect(() => checkErrors(error, channel)).toThrow(error);
    expect(channel.of("error")).toHaveLength(1);
  });
});

// Whatever a real djLint prints must reach the same branch. Skipped where no
// djLint is installed, such as CI; the wordings above are copies of this.
const installed = await execa("djlint", ["--version"], { reject: false });

describe.skipIf(installed.failed)("checkErrors with a real djLint", () => {
  async function realFailure(option: string): Promise<CustomExecaError> {
    const result = await execa("djlint", ["-", option], {
      input: "<div></div>",
      reject: false,
    });
    expect(result.failed).toBe(true);
    return result as unknown as CustomExecaError;
  }

  it("is generic for an option unknown to both", async () => {
    const failure = await realFailure("--max-blank-lines-XYZ");
    const { message } = report(failure);
    expect(failure.stderr).toContain("No such option");
    expect(message).not.toContain("does not support the");
  });

  it("is actionable once the option is one the extension knows", async () => {
    const failure = await realFailure("--max-blank-lines-XYZ");
    const { message } = report(
      makeExecaError({
        exitCode: failure.exitCode,
        stderr: failure.stderr.replace(
          "--max-blank-lines-XYZ",
          "--max-blank-lines",
        ),
      }),
    );
    expect(message).toContain("does not support the");
  });
});

describe("isValidLintResult", () => {
  it.each([
    ["findings with empty stderr", 1, "", true, true],
    ["findings with progress on stderr", 1, "Linting 1/1 files", true, true],
    ["a format run", 1, "", false, false],
    ["a traceback", 1, "Traceback (most recent call last)", true, false],
    ["a usage error", 2, "", true, false],
    ["exit 1 with a real complaint", 1, "Traceback", true, false],
  ])("%s", (_label, exitCode, stderr, isLint, expected) => {
    expect(
      isValidLintResult(makeExecaError({ exitCode, stderr }), isLint),
    ).toBe(expected);
  });
});

describe("findings with a warning on stderr", () => {
  it("are findings", () => {
    expect(
      isValidLintResult(
        makeExecaError({
          exitCode: 1,
          stderr: "Invalid pyproject.toml",
          stdout: "H013",
        }),
        true,
      ),
    ).toBe(true);
  });
});

describe("isDjlintUnavailable", () => {
  it.each(["EACCES", "ENOENT", "ENOEXEC", "UNKNOWN"])(
    "recognizes a command that cannot start, %s",
    (code) => {
      expect(isDjlintUnavailable(makeExecaError({ code }))).toBe(true);
    },
  );

  it.each([103, 127, 9009])(
    "recognizes the exit code %d of a launcher",
    (exitCode) => {
      expect(isDjlintUnavailable(makeExecaError({ exitCode }))).toBe(true);
    },
  );

  it.each([
    "No module named djlint",
    "/usr/bin/python: No module named 'djlint'",
  ])("recognizes %j", (stderr) => {
    expect(isDjlintUnavailable(makeExecaError({ stderr }))).toBe(true);
  });

  it("does not mistake a broken djLint install for a missing one", () => {
    expect(
      isDjlintUnavailable(
        makeExecaError({ stderr: "No module named 'djlint.settings'" }),
      ),
    ).toBe(false);
  });
});

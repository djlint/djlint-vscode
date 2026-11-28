// checkErrors() must turn djLint rejecting an option into the actionable
// "update djLint" message rather than a bare dump, in every wording click has
// used for that rejection.
import { beforeEach, describe, expect, it } from "vitest";

import { checkErrors, isValidLintResult } from "../engine/subprocess/errors.js";
import { isDjlintUnavailable, run } from "../engine/subprocess/exec.js";
import type { RunError } from "../engine/subprocess/exec.js";
import { RUN_TIMEOUT_MS } from "../engine/types.js";
import { failureOf, installedDjlint, makeChannel, makeRunError } from "./helpers.js";
import { control, resetVscode } from "./vscode-stub.js";

// The djLint on PATH, if any, for the suite that checks its real wording.
const installed = await installedDjlint();

describe("djLint errors", () => {
  beforeEach(() => {
    resetVscode();
  });

  function report(error: RunError): { message: string | undefined; rethrown: unknown } {
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

  describe(checkErrors, () => {
    it("names the setting and the version for the modern click wording", () => {
      const { message } = report(
        makeRunError({
          exitCode: 2,
          stderr: MODERN.replace("--max-blank-lines-XYZ", "--max-blank-lines"),
        }),
      );
      expect(message).toContain("does not support the `djlint.maxBlankLines` option");
      expect(message).toContain("version 1.31 or newer");
      expect(message).toContain("https://djlint.com/docs/getting-started/");
    });

    it("names the setting for the older click wording", () => {
      const { message } = report(
        makeRunError({ exitCode: 2, stderr: "Error: No such option: --max-blank-lines" }),
      );
      expect(message).toContain("does not support the");
    });

    it("is generic for a flag the extension does not know", () => {
      const { message } = report(makeRunError({ exitCode: 2, stderr: MODERN }));
      expect(message).not.toContain("does not support the");
      expect(message).toMatch(/^djLint failed: Error: No such option/u);
    });

    it("does not read a verdict into a process that was killed", () => {
      const { message } = report(
        makeRunError({ stderr: "Error: No such option: --max-blank-lines" }),
      );
      expect(message).not.toContain("does not support the");
    });

    it("says djLint ran out of time", () => {
      const { message } = report(makeRunError({ timedOut: true }));
      expect(message).toBe("djLint did not finish in time.");
    });

    it("names the signal that stopped djLint", () => {
      const { message } = report(makeRunError({ signal: "SIGKILL" }));
      expect(message).toBe("djLint was stopped by SIGKILL.");
    });

    it("says why djLint could not start", () => {
      const { message } = report(makeRunError({ code: "E2BIG" }));
      expect(message).toBe("djLint could not start: E2BIG.");
    });

    it("says djLint could not start when nothing says why", () => {
      const { message } = report(makeRunError({}));
      expect(message).toBe("djLint could not start: unknown error.");
    });

    it("summarizes stderr by its last non-empty line", () => {
      const { message } = report(
        makeRunError({ exitCode: 1, stderr: "Traceback\n  File x\nValueError: bad value\n\n" }),
      );
      expect(message).toBe("djLint failed: ValueError: bad value");
    });

    it("falls back to the exit code without stderr", () => {
      const { message } = report(makeRunError({ exitCode: 3 }));
      expect(message).toBe("djLint failed with exit code 3.");
    });

    it("logs and rethrows the original error", () => {
      const error = makeRunError({ exitCode: 3 });
      const channel = makeChannel();
      expect(() => checkErrors(error, channel)).toThrow(error);
      expect(channel.of("error")).toHaveLength(1);
    });
  });

  // Whatever a real djLint prints must reach the same branch. Skipped where no
  // djLint is installed, such as CI; the wordings above are copies of this.
  describe.skipIf(installed == null)("checkErrors with a real djLint", () => {
    async function realFailure(option: string): Promise<RunError> {
      return failureOf(
        run("djlint", ["-", option], { input: "<div></div>", timeout: RUN_TIMEOUT_MS }),
      );
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
        makeRunError({
          exitCode: failure.exitCode,
          stderr: failure.stderr.replace("--max-blank-lines-XYZ", "--max-blank-lines"),
        }),
      );
      expect(message).toContain("does not support the");
    });
  });

  describe(isValidLintResult, () => {
    it.each([
      ["findings with empty stderr", 1, "", true, true],
      ["findings with progress on stderr", 1, "Linting 1/1 files", true, true],
      ["a format run", 1, "", false, false],
      ["a traceback", 1, "Traceback (most recent call last)", true, false],
      ["a usage error", 2, "", true, false],
    ])("%s", (_label, exitCode, stderr, isLint, expected) => {
      expect(isValidLintResult(makeRunError({ exitCode, stderr }), isLint)).toBe(expected);
    });
  });

  describe("findings with a warning on stderr", () => {
    it("are findings", () => {
      expect(
        isValidLintResult(
          makeRunError({ exitCode: 1, stderr: "Invalid pyproject.toml", stdout: "H013" }),
          true,
        ),
      ).toBe(true);
    });
  });

  describe(isDjlintUnavailable, () => {
    it.each(["EACCES", "ENOENT", "ENOEXEC", "UNKNOWN"])(
      "recognizes a command that cannot start, %s",
      (code) => {
        expect(isDjlintUnavailable(makeRunError({ code }))).toBe(true);
      },
    );

    it.each([103, 127, 9009])("recognizes the exit code %d of a launcher", (exitCode) => {
      expect(isDjlintUnavailable(makeRunError({ exitCode }))).toBe(true);
    });

    it.each(["No module named djlint", "/usr/bin/python: No module named 'djlint'"])(
      "recognizes %j",
      (stderr) => {
        expect(isDjlintUnavailable(makeRunError({ stderr }))).toBe(true);
      },
    );

    it("does not mistake a broken djLint install for a missing one", () => {
      expect(
        isDjlintUnavailable(makeRunError({ stderr: "No module named 'djlint.settings'" })),
      ).toBe(false);
    });
  });
});

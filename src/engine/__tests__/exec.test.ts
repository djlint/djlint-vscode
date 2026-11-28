// How `run` starts a real process and reports how it ended, which the engine
// suites take as given.
import path from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { failureOf } from "../../__tests__/helpers.js";
import { run } from "../subprocess/exec.js";
import type { RunOptions } from "../subprocess/exec.js";

async function node(script: string, options: Partial<RunOptions> = {}): ReturnType<typeof run> {
  return run(process.execPath, ["-e", script], { timeout: 30_000, ...options });
}

describe(run, () => {
  it("feeds the input and keeps the output as printed", async () => {
    await expect(
      node("process.stdin.pipe(process.stdout)", { input: "<p>é</p>\r\n" }),
    ).resolves.toStrictEqual({ stderr: "", stdout: "<p>é</p>\r\n" });
  });

  it("gives a command without input none to wait for", async () => {
    await expect(
      node("process.stdin.resume().on('end', () => process.stdout.write('end'))"),
    ).resolves.toMatchObject({ stdout: "end" });
  });

  it("adds the environment to its own and leaves PATH as it is", async () => {
    const { stdout } = await node(
      "process.stdout.write(JSON.stringify([process.env.PATH, process.env.DJLINT_TEST]))",
      { env: { DJLINT_TEST: "set" } },
    );
    expect(JSON.parse(stdout)).toStrictEqual([process.env["PATH"], "set"]);
  });

  it("reports an exit code with what was printed", async () => {
    const error = await failureOf(
      node(
        String.raw`process.stdout.write('out'); process.stderr.write('Error: bad\n'); process.exit(2)`,
      ),
    );
    expect(error).toMatchObject({
      code: void 0,
      exitCode: 2,
      signal: void 0,
      stderr: "Error: bad\n",
      stdout: "out",
      timedOut: false,
    });
    expect(error.message).toMatch(/^Command failed with exit code 2: .+\n\nError: bad$/u);
  });

  it("reports a command that cannot start", async () => {
    await expect(
      failureOf(node("", { cwd: path.join(import.meta.dirname, "missing") })),
    ).resolves.toMatchObject({ code: "ENOENT", exitCode: void 0, timedOut: false });
  });

  it("stops a command when told to", async () => {
    const controller = new AbortController();
    const running = node("setInterval(() => {}, 1000)", { signal: controller.signal });
    controller.abort();
    await expect(failureOf(running)).resolves.toMatchObject({ signal: "SIGTERM", timedOut: false });
  });
});

// PyodideEngine's side of the worker protocol, with the worker replaced. Every
// way a request can end must settle its caller: a format promise left pending
// would hang the editor's "Formatting..." state with nothing to retry against.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { everySetting } from "../../../__tests__/every-setting.js";
import { FakeWorker } from "../../../__tests__/fake-worker.js";
import {
  formattingOptions,
  liveToken,
  makeChannel,
  makeConfig,
  makeDocument,
  makeStatus,
  portable,
  setWorkspaceFolders,
} from "../../../__tests__/helpers.js";
import { control, resetVscode, Uri } from "../../../__tests__/vscode-stub.js";
import { formattingArgs, lintingArgs } from "../../../args.js";
import { getDocumentFolder } from "../../document-folder.js";
import { RUN_TIMEOUT_MS } from "../../types.js";
import type { LintDiagnostic } from "../../types.js";
import { PyodideEngine } from "../index.js";
import { createNodeWorker } from "../node-worker.js";
import type { RunRequest } from "../protocol.js";

vi.mock("node:worker_threads", async () => {
  const { FakeWorker: Worker } = await import("../../../__tests__/fake-worker.js");
  return { Worker };
});

const document = makeDocument("/w/sub/t.html", "<p>x</p>");
const config = makeConfig();

function makeEngine(canReadProjectFiles = true): {
  channel: ReturnType<typeof makeChannel>;
  engine: PyodideEngine;
} {
  const channel = makeChannel();
  return {
    channel,
    engine: new PyodideEngine(
      () => createNodeWorker("/ext/worker.cjs", "/ext/pyodide"),
      channel,
      canReadProjectFiles,
      makeStatus(),
      getDocumentFolder,
    ),
  };
}

async function format(
  engine: PyodideEngine,
  token = liveToken(),
  workspaceConfig = config,
): Promise<string> {
  return engine.format(document, workspaceConfig, formattingOptions, token);
}

/** The request a format with these settings sends. */
function sentFor(
  values: Readonly<Record<string, unknown>>,
  mode: "format" | "lint" = "format",
): RunRequest {
  const { engine } = makeEngine();
  const workspaceConfig = makeConfig(values);
  const pending: Promise<unknown> =
    mode === "format"
      ? format(engine, liveToken(), workspaceConfig)
      : engine.lint(document, workspaceConfig, liveToken());
  pending.catch(() => void 0);
  const request = FakeWorker.latest.lastRun;
  engine.dispose();
  return request;
}

beforeEach(() => {
  resetVscode();
  FakeWorker.reset();
  setWorkspaceFolders("/w");
});

describe("the run request", () => {
  it("describes the document", () => {
    const request = sentFor({});
    expect(request).toMatchObject({
      cwd: Uri.file("/w/sub").fsPath,
      filename: "/w/sub/t.html",
      id: 1,
      mode: "format",
      src: "<p>x</p>",
      type: "run",
    });
  });

  it("sends no path option when project files are off limits", () => {
    const { engine } = makeEngine(false);
    engine
      .format(
        makeDocument("/w/sub/t.html"),
        makeConfig({ configuration: "/w/.djlintrc", rules: "/w/rules.yaml" }),
        formattingOptions,
        liveToken(),
      )
      .catch(() => void 0);
    expect(FakeWorker.latest.lastRun.pathOptions).toStrictEqual({});
  });

  it("has no cwd when project files are off limits", () => {
    const { engine } = makeEngine(false);
    format(engine).catch(() => void 0);
    expect(FakeWorker.latest.lastRun.cwd).toBeUndefined();
    engine.dispose();
  });

  it("has no cwd for a document that is not a local file", async () => {
    const { engine } = makeEngine();
    engine
      .lint(makeDocument(vscode.Uri.parse("vscode-vfs://github/o/r/t.html")), config, liveToken())
      .catch(() => void 0);
    await vi.waitFor(() => {
      expect(FakeWorker.latest.lastRun.cwd).toBeUndefined();
    });
    engine.dispose();
  });

  it("gives every request its own id", () => {
    const { engine } = makeEngine();
    format(engine).catch(() => void 0);
    format(engine).catch(() => void 0);
    expect(FakeWorker.latest.runs.map(({ id }) => id)).toStrictEqual([1, 2]);
    engine.dispose();
  });

  it("uses djLint's snake_case names for format settings", () => {
    const { options } = sentFor({
      customBlocks: ["foo", "bar"],
      formatCss: true,
      formatJs: false,
      maxLineLength: 120,
      profile: "django",
      useEditorIndentation: true,
    });
    expect(options).toStrictEqual({
      custom_blocks: "foo,bar",
      format_css: true,
      indent: 2,
      max_line_length: 120,
      profile: "django",
    });
  });

  it("omits false booleans rather than sending them", () => {
    const { options } = sentFor({ formatJs: false });
    expect(options).not.toHaveProperty("format_js");
  });

  it("uses the lint argument set for a lint, which has no indent", () => {
    const { options } = sentFor(
      { formatCss: true, ignore: ["H013"], profile: "django", useEditorIndentation: true },
      "lint",
    );
    expect(options).toStrictEqual({ ignore: "H013", profile: "django" });
  });

  it("separates host paths from plain settings", () => {
    const request = sentFor({ configuration: "/ws/.djlintrc", rules: "conf/rules.yaml" }, "lint");
    expect(request.options).toStrictEqual({});
    expect(Object.keys(request.pathOptions).toSorted()).toStrictEqual(["configuration", "rules"]);
    expect(portable(request.pathOptions["configuration"] ?? "")).toBe("/ws/.djlintrc");
    expect(portable(request.pathOptions["rules"] ?? "")).toMatch(/\/w\/conf\/rules\.yaml$/u);
  });

  it("drops a relative path it has no workspace folder to resolve against", () => {
    setWorkspaceFolders();
    const { pathOptions } = sentFor({ configuration: "conf.toml" });
    expect(pathOptions).toStrictEqual({});
  });

  it("carries no CLI-only flags and no dashed names", () => {
    const format = sentFor(everySetting(formattingArgs)).options;
    const lint = sentFor(everySetting(lintingArgs), "lint").options;
    for (const name of Object.keys({ ...format, ...lint })) {
      expect(name).not.toContain("-");
    }
    expect(format).not.toHaveProperty("quiet");
    expect(format).not.toHaveProperty("reformat");
    expect(lint).not.toHaveProperty("linter_output_format");
    expect(lint).not.toHaveProperty("stdin_filename");
  });
});

describe("responses", () => {
  it("resolves a format with the worker's output", async () => {
    const { engine } = makeEngine();
    const pending = format(engine);
    FakeWorker.latest.succeed(1, "FORMATTED");
    await expect(pending).resolves.toBe("FORMATTED");
  });

  it("parses a lint's JSON", async () => {
    const diagnostics: LintDiagnostic[] = [{ code: "H013", column: 5, line: 1, message: "m" }];
    const { engine } = makeEngine();
    const pending = engine.lint(document, config, liveToken());
    FakeWorker.latest.succeed(1, JSON.stringify(diagnostics));
    await expect(pending).resolves.toStrictEqual(diagnostics);
  });

  it("matches responses to requests by id", async () => {
    const { engine } = makeEngine();
    const first = format(engine);
    const second = format(engine);
    FakeWorker.latest.succeed(2, "SECOND");
    FakeWorker.latest.succeed(1, "FIRST");
    await expect(first).resolves.toBe("FIRST");
    await expect(second).resolves.toBe("SECOND");
  });

  it("reuses one worker", async () => {
    const { engine } = makeEngine();
    const first = format(engine);
    FakeWorker.latest.succeed(1, "");
    await first;
    const second = format(engine);
    FakeWorker.latest.succeed(2, "");
    await second;
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("ignores a response nobody is waiting for", () => {
    const { engine } = makeEngine();
    format(engine).catch(() => void 0);
    expect(() => {
      FakeWorker.latest.succeed(99, "");
    }).not.toThrow();
    engine.dispose();
  });

  it("forwards the worker's logs at their level", () => {
    const { channel, engine } = makeEngine();
    format(engine).catch(() => void 0);
    const worker = FakeWorker.latest;
    worker.respond({ level: "debug", line: "stdout line", type: "log" });
    worker.respond({ level: "warn", line: "stderr line", type: "log" });
    worker.respond({ type: "ready", version: "1.47.1" });
    expect(channel.of("debug").join()).toContain("stdout line");
    expect(channel.of("warn").join()).toContain("stderr line");
    expect(channel.of("info").join()).toContain("bundled djLint 1.47.1");
    engine.dispose();
  });
});

describe("a runtime that fails to start", () => {
  it("is dropped, so the next request starts a new one", async () => {
    const { engine } = makeEngine();
    const first = format(engine);
    const worker = FakeWorker.latest;
    worker.respond({ error: "fetch failed", type: "boot-failed" });
    await expect(first).rejects.toThrow("fetch failed");
    expect(worker.terminated).toBe(true);

    format(engine).catch(() => void 0);
    expect(FakeWorker.latest).not.toBe(worker);
    engine.dispose();
  });
});

describe("a runtime that crashes", () => {
  it("is replaced, because nothing it runs next can be trusted", async () => {
    const { engine } = makeEngine();
    const first = format(engine);
    const crashed = FakeWorker.latest;
    crashed.respond({ error: "fatal", type: "crashed" });
    await expect(first).rejects.toThrow("Bundled djLint runtime crashed: fatal");
    expect(crashed.terminated).toBe(true);

    const second = format(engine);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.latest.succeed(2, "ok");
    await expect(second).resolves.toBe("ok");
  });
});

describe("a replaced worker", () => {
  it("is not listened to any more", async () => {
    const { engine } = makeEngine();
    const first = format(engine);
    const old = FakeWorker.latest;
    old.emit("exit", 1);
    await expect(first).rejects.toThrow("exited unexpectedly");

    const second = format(engine);
    const current = FakeWorker.latest;
    old.respond({ error: "too late", type: "boot-failed" });
    expect(current.terminated).toBe(false);
    current.succeed(2, "ok");
    await expect(second).resolves.toBe("ok");
  });
});

describe("djLint failures", () => {
  const TRACEBACK =
    'Traceback (most recent call last):\n  File "glue.py", line 26, in run\nValueError: bad value\n';

  it("shows a traceback's last line but logs it in full", async () => {
    const { channel, engine } = makeEngine();
    const pending = format(engine);
    FakeWorker.latest.failRun(1, TRACEBACK);
    await expect(pending).rejects.toThrow(TRACEBACK);
    expect(control.shownErrors).toStrictEqual(["Bundled djLint failed: ValueError: bad value"]);
    expect(channel.of("error")).toStrictEqual([TRACEBACK]);
  });

  it("shows a failure with no text at all", async () => {
    const { engine } = makeEngine();
    const pending = format(engine);
    FakeWorker.latest.failRun(1, "");
    await expect(pending).rejects.toThrow(/^$/u);
    expect(control.shownErrors).toStrictEqual(["Bundled djLint failed: "]);
  });

  it("notifies once for a failure that repeats, logging every one", async () => {
    const { channel, engine } = makeEngine();
    const first = format(engine);
    FakeWorker.latest.failRun(1, TRACEBACK);
    await expect(first).rejects.toThrow(TRACEBACK);
    const second = format(engine);
    FakeWorker.latest.failRun(2, TRACEBACK);
    await expect(second).rejects.toThrow(TRACEBACK);
    expect(control.shownErrors).toHaveLength(1);
    expect(channel.of("error")).toHaveLength(2);
  });

  it("notifies again for a different failure", async () => {
    const { engine } = makeEngine();
    const first = format(engine);
    FakeWorker.latest.failRun(1, "first");
    await expect(first).rejects.toThrow("first");
    const second = format(engine);
    FakeWorker.latest.failRun(2, "second");
    await expect(second).rejects.toThrow("second");
    expect(control.shownErrors).toHaveLength(2);
  });

  it("opens the log from the notification's Details button", async () => {
    control.errorMessageChoice = "Details";
    const { channel, engine } = makeEngine();
    const pending = format(engine);
    FakeWorker.latest.failRun(1, "broken");
    await expect(pending).rejects.toThrow("broken");
    await vi.waitFor(() => {
      expect(channel.shownCount).toBe(1);
    });
  });

  it("keeps the worker after a failed run", async () => {
    const { engine } = makeEngine();
    const pending = format(engine);
    FakeWorker.latest.failRun(1, "broken");
    await expect(pending).rejects.toThrow("broken");
    expect(FakeWorker.latest.terminated).toBe(false);
  });
});

describe("the worker dying", () => {
  it("rejects everything in flight on an error, then starts afresh", async () => {
    const { engine } = makeEngine();
    const first = format(engine);
    const second = format(engine);
    const dead = FakeWorker.latest;
    const error = new Error("out of memory");
    dead.emit("error", error);
    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    expect(dead.terminated).toBe(true);
    expect(control.shownErrors).toStrictEqual(["Bundled djLint runtime failed: out of memory"]);

    const third = format(engine);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.latest.succeed(3, "ok");
    await expect(third).resolves.toBe("ok");
  });

  it("rejects everything in flight on an unexpected exit", async () => {
    const { channel, engine } = makeEngine();
    const pending = format(engine);
    FakeWorker.latest.emit("exit", 7);
    const message = "Bundled djLint runtime exited unexpectedly (7)";
    await expect(pending).rejects.toThrow(message);
    expect(control.shownErrors).toStrictEqual([message]);
    expect(channel.of("error")).toStrictEqual([message]);
  });

  it("does not blame the new worker for the old one's exit", async () => {
    const { engine } = makeEngine();
    const first = format(engine);
    const old = FakeWorker.latest;
    old.emit("error", new Error("died"));
    await expect(first).rejects.toThrow("died");

    const second = format(engine);
    old.emit("exit", 1);
    old.emit("error", new Error("died again"));
    FakeWorker.latest.succeed(2, "ok");
    await expect(second).resolves.toBe("ok");
    expect(control.shownErrors).toHaveLength(1);
  });

  it("rejects when the worker cannot be started at all", async () => {
    FakeWorker.constructionError = new Error("no such file");
    const { engine } = makeEngine();
    await expect(format(engine)).rejects.toThrow("no such file");
  });
});

describe("timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a worker that does not answer, and restarts it", async () => {
    const { channel, engine } = makeEngine();
    const first = format(engine);
    const second = format(engine);
    const wedged = FakeWorker.latest;

    // oxlint-disable-next-line vitest/valid-expect -- awaited below, once the clock has run out
    const rejection = expect(first).rejects.toThrow("timed out");
    // oxlint-disable-next-line vitest/valid-expect -- awaited below, once the clock has run out
    const otherRejection = expect(second).rejects.toThrow("timed out");
    vi.advanceTimersByTime(RUN_TIMEOUT_MS);
    await rejection;
    await otherRejection;

    expect(wedged.terminated).toBe(true);
    const message = `Bundled djLint did not respond within ${RUN_TIMEOUT_MS / 1000} seconds; restarting it.`;
    expect(control.shownErrors).toStrictEqual([message]);
    expect(channel.of("error")).toStrictEqual([message]);

    const third = format(engine);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.latest.succeed(3, "ok");
    await expect(third).resolves.toBe("ok");
  });

  it("waits the full timeout", () => {
    const { engine } = makeEngine();
    format(engine).catch(() => void 0);
    vi.advanceTimersByTime(RUN_TIMEOUT_MS - 1);
    expect(FakeWorker.latest.terminated).toBe(false);
    engine.dispose();
  });

  it.each([
    [
      "an answer",
      (): void => {
        FakeWorker.latest.succeed(1, "");
      },
    ],
    [
      "a failure",
      (): void => {
        FakeWorker.latest.failRun(1, "broken");
      },
    ],
  ])("stops the clock on %s", (_label, settle) => {
    const { engine } = makeEngine();
    format(engine).catch(() => void 0);
    settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the clock running after a cancellation, until the worker answers", () => {
    const { engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    format(engine, source.token).catch(() => void 0);
    source.cancel();
    expect(vi.getTimerCount()).toBe(1);

    const { id } = FakeWorker.latest.lastRun;
    FakeWorker.latest.failRun(id, "cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not mistake a long queue for a stuck run", async () => {
    const { engine } = makeEngine();
    format(engine).catch(() => void 0);
    const first = FakeWorker.latest.lastRun.id;
    format(engine).catch(() => void 0);
    const second = FakeWorker.latest.lastRun.id;

    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS - 1);
    FakeWorker.latest.succeed(first, "x");
    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS - 1);
    expect(FakeWorker.latest.terminated).toBe(false);

    FakeWorker.latest.succeed(second, "x");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a cancelled run that never finishes", async () => {
    const { engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    format(engine, source.token).catch(() => void 0);
    source.cancel();
    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS);
    expect(FakeWorker.latest.terminated).toBe(true);
  });

  it("does not report the failure of a cancelled run", () => {
    const { channel, engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    format(engine, source.token).catch(() => void 0);
    source.cancel();
    const { id } = FakeWorker.latest.lastRun;
    FakeWorker.latest.failRun(id, "cancelled");
    expect(channel.of("error")).toHaveLength(0);
  });

  it("stops the clock on disposal", () => {
    const { engine } = makeEngine();
    format(engine).catch(() => void 0);
    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leave a clock running for a worker that never started", async () => {
    FakeWorker.constructionError = new Error("no such file");
    const { engine } = makeEngine();
    await expect(format(engine)).rejects.toThrow("no such file");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("cancellation", () => {
  it("cancels a queued request and rejects with CancellationError", async () => {
    const { engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    const pending = format(engine, source.token);
    const worker = FakeWorker.latest;
    source.cancel();
    await expect(pending).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(worker.requests.at(-1)).toStrictEqual({ id: 1, type: "cancel" });
    expect(worker.terminated).toBe(false);
    engine.dispose();
  });

  it("ignores a result that crosses the cancellation", async () => {
    const { engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    const pending = format(engine, source.token);
    source.cancel();
    FakeWorker.latest.succeed(1, "too late");
    await expect(pending).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(control.shownErrors).toStrictEqual([]);
    engine.dispose();
  });

  it("leaves other requests in flight", async () => {
    const { engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    const cancelled = format(engine, source.token);
    const other = format(engine);
    source.cancel();
    await expect(cancelled).rejects.toBeInstanceOf(vscode.CancellationError);
    FakeWorker.latest.succeed(2, "ok");
    await expect(other).resolves.toBe("ok");
  });

  it("does not start a worker for a request cancelled up front", async () => {
    const { engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    await expect(format(engine, source.token)).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("stays usable afterwards", async () => {
    const { engine } = makeEngine();
    const source = new vscode.CancellationTokenSource();
    const pending = format(engine, source.token);
    source.cancel();
    await expect(pending).rejects.toBeInstanceOf(vscode.CancellationError);
    const after = format(engine);
    FakeWorker.latest.succeed(2, "ok");
    await expect(after).resolves.toBe("ok");
  });
});

describe("dispose", () => {
  it("settles a request in flight and stops the worker", async () => {
    const { engine } = makeEngine();
    const pending = format(engine);
    const worker = FakeWorker.latest;
    engine.dispose();
    await expect(pending).rejects.toThrow("djLint engine disposed");
    expect(worker.terminated).toBe(true);
    expect(control.shownErrors).toStrictEqual([]);
  });

  it("does not report the exit it caused", async () => {
    const { engine } = makeEngine();
    const pending = format(engine);
    const worker = FakeWorker.latest;
    engine.dispose();
    worker.emit("exit", 1);
    await expect(pending).rejects.toThrow("djLint engine disposed");
    expect(control.shownErrors).toStrictEqual([]);
  });

  it("refuses new work rather than resurrect a worker", async () => {
    const { engine } = makeEngine();
    engine.dispose();
    await expect(format(engine)).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

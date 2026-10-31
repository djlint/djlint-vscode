// What EngineManager builds decides whether workspace code can run at all: an
// untrusted workspace must never reach a subprocess or its own project files.
import path from "node:path";
import { execa } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWorker } from "../../__tests__/fake-worker.js";
import {
  flush,
  formattingOptions,
  liveToken,
  makeChannel,
  makeConfig,
  makeDocument,
  makeStatus,
  setWorkspaceFolders,
} from "../../__tests__/helpers.js";
import { control, resetVscode, Uri } from "../../__tests__/vscode-stub.js";
import type { PythonEnvironments } from "../../python/environment.js";
import { createDesktopEngine } from "../desktop.js";
import { PyodideEngine } from "../pyodide/index.js";
import { EngineManager, FallbackEngine } from "../select.js";

vi.mock("node:worker_threads", async () => {
  const { FakeWorker: Worker } = await import("../../__tests__/fake-worker.js");
  return { Worker };
});

vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: vi.fn(),
}));

const extensionPath = "/ext";

function makeManager(): EngineManager {
  return new EngineManager(() =>
    createDesktopEngine(
      Uri.file(extensionPath) as never,
      makeChannel(),
      {} as PythonEnvironments,
      makeStatus(),
    ),
  );
}

const document = makeDocument("/w/sub/t.html", "<p>x</p>");

beforeEach(() => {
  resetVscode();
  FakeWorker.reset();
  vi.mocked(execa).mockReset();
  setWorkspaceFolders("/w");
});

describe("EngineManager", () => {
  it("builds the fallback chain in a trusted workspace", () => {
    expect(makeManager().engine).toBeInstanceOf(FallbackEngine);
  });

  it("builds a bundled engine directly in an untrusted workspace", () => {
    control.isTrusted = false;
    expect(makeManager().engine).toBeInstanceOf(PyodideEngine);
  });

  it("starts nothing until an engine does some work", () => {
    expect(makeManager().engine).toBeDefined();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(execa).not.toHaveBeenCalled();
  });

  it("keeps one engine until reset, then disposes it", () => {
    const manager = makeManager();
    const { engine } = manager;
    const dispose = vi.spyOn(engine, "dispose");
    expect(manager.engine).toBe(engine);

    manager.reset();
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.engine).not.toBe(engine);
  });

  it("does not build an engine just to dispose it", () => {
    expect(() => {
      makeManager().dispose();
    }).not.toThrow();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("picks up trust being granted on reset", () => {
    control.isTrusted = false;
    const manager = makeManager();
    expect(manager.engine).toBeInstanceOf(PyodideEngine);

    control.isTrusted = true;
    manager.reset();
    expect(manager.engine).toBeInstanceOf(FallbackEngine);
  });

  it("points the worker at the extension's own files", async () => {
    control.isTrusted = false;
    void makeManager()
      .engine.format(document, makeConfig(), formattingOptions, liveToken())
      .catch(() => void 0);
    await flush();
    const worker = FakeWorker.latest;
    expect(worker.path).toBe(
      Uri.file(path.posix.join(extensionPath, "dist/pyodide-worker.cjs"))
        .fsPath,
    );
    expect(worker.options.workerData.indexURL).toBe(
      Uri.file(path.posix.join(extensionPath, "assets/pyodide")).fsPath,
    );
  });

  it("passes no cwd to the worker in an untrusted workspace", async () => {
    control.isTrusted = false;
    const manager = makeManager();
    void manager.engine
      .format(document, makeConfig(), formattingOptions, liveToken())
      .catch(() => void 0);
    await flush();
    expect(FakeWorker.latest.lastRun.cwd).toBeUndefined();
    expect(execa).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("passes the document's folder to the worker in a trusted workspace", async () => {
    const manager = makeManager();
    void manager.engine
      .format(
        document,
        makeConfig({ importStrategy: "useBundled" }),
        formattingOptions,
        liveToken(),
      )
      .catch(() => void 0);
    await flush();
    expect(FakeWorker.latest.lastRun.cwd).toBe(Uri.file("/w/sub").fsPath);
    expect(execa).not.toHaveBeenCalled();
    manager.dispose();
  });
});

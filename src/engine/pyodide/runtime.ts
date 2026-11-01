import type { loadPyodide, PyodideAPI } from "pyodide";

import GLUE from "./glue.py";
import type { RunRequest, RunResponse, WorkerRequest, WorkerResponse } from "./protocol.js";

type Run = (
  mode: string,
  src: string,
  options: string,
  pathOptions: string,
  filename: string,
  cwd: string | undefined,
  project: string | undefined,
) => string;

interface Runtime {
  pyodide: PyodideAPI;
  run: Run;
}

interface WorkerHost {
  indexURL: string;
  importPyodide: () => Promise<{ loadPyodide: typeof loadPyodide }>;
  listen: (listener: (request: WorkerRequest) => void) => void;
  send: (response: WorkerResponse) => void;
  toGuestPath: (pyodide: PyodideAPI, hostPath: string) => string;
}

// After a fatal error, Pyodide makes no promises about anything it runs next.
function isFatal(e: unknown): boolean {
  return e instanceof Error && "pyodide_fatal_error" in e;
}

export function serve(host: WorkerHost): void {
  function logDebug(line: string): void {
    host.send({ level: "debug", line, type: "log" });
  }

  function logWarning(line: string): void {
    host.send({ level: "warn", line, type: "log" });
  }

  async function boot(): Promise<Runtime> {
    const { indexURL } = host;
    const module = await host.importPyodide();
    const pyodide = await module.loadPyodide({ indexURL, stderr: logWarning, stdout: logDebug });
    await pyodide.loadPackage("djlint", { errorCallback: logWarning, messageCallback: logDebug });
    pyodide.runPython(GLUE);
    const version = pyodide.runPython(
      'import importlib.metadata; importlib.metadata.version("djlint")',
    ) as string;
    host.send({ type: "ready", version });
    return { pyodide, run: pyodide.globals["get"]("run") as Run };
  }

  const ready = boot();
  // An unhandled boot rejection would kill the worker outright. The host starts another one instead, which also gets over a failed download in a browser.
  // oxlint-disable-next-line promise/prefer-await-to-then -- the worker never waits on this, it only reports the failure
  ready.catch((e: unknown) => {
    host.send({ error: e instanceof Error ? e.message : String(e), type: "boot-failed" });
  });

  function execute({ pyodide, run }: Runtime, request: RunRequest): string {
    const { cwd, filename, mode, options, pathOptions, project, src } = request;
    const guestPathOptions = Object.entries(pathOptions).map(([name, value]) => [
      name,
      project == null ? host.toGuestPath(pyodide, value) : value,
    ]);
    return run(
      mode,
      src,
      JSON.stringify(options),
      JSON.stringify(Object.fromEntries(guestPathOptions)),
      filename,
      cwd == null ? void 0 : host.toGuestPath(pyodide, cwd),
      project == null ? void 0 : JSON.stringify(project),
    );
  }

  const queue = new Map<number, RunRequest>();

  async function runQueued(id: number): Promise<void> {
    let response: RunResponse;
    try {
      const runtime = await ready;
      // Python blocks this thread, so a cancellation sent while an earlier request ran is still in line behind its request. Let it arrive first.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      const request = queue.get(id);
      if (request == null) {
        return;
      }
      response = { id, ok: true, output: execute(runtime, request), type: "result" };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (isFatal(e)) {
        host.send({ error, type: "crashed" });
        return;
      }
      response = { error, id, ok: false, type: "result" };
    }
    queue.delete(id);
    host.send(response);
  }

  host.listen((request) => {
    if (request.type === "cancel") {
      if (queue.delete(request.id)) {
        host.send({ error: "cancelled", id: request.id, ok: false, type: "result" });
      }
      return;
    }
    queue.set(request.id, request);
    void runQueued(request.id);
  });
}

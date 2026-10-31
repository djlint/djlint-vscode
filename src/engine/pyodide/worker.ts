import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { loadPyodide, PyodideAPI } from "pyodide";
import GLUE from "./glue.py";
import type {
  RunRequest,
  RunResponse,
  WorkerData,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";

type Run = (
  mode: string,
  src: string,
  options: string,
  pathOptions: string,
  filename: string,
  cwd: string | undefined,
) => string;

interface Runtime {
  pyodide: PyodideAPI;
  run: Run;
}

if (!parentPort) {
  throw new Error("pyodide worker must run as a worker_thread");
}
const port = parentPort;

function send(response: WorkerResponse): void {
  port.postMessage(response);
}

function logDebug(line: string): void {
  send({ level: "debug", line, type: "log" });
}

function logWarning(line: string): void {
  send({ level: "warn", line, type: "log" });
}

async function boot(): Promise<Runtime> {
  const { indexURL } = workerData as WorkerData;
  const url = pathToFileURL(path.join(indexURL, "pyodide.mjs")).href;
  const runtime = (await import(url)) as { loadPyodide: typeof loadPyodide };
  const pyodide = await runtime.loadPyodide({
    indexURL,
    stderr: logWarning,
    stdout: logDebug,
  });
  await pyodide.loadPackage("djlint", {
    errorCallback: logWarning,
    messageCallback: logDebug,
  });
  pyodide.runPython(GLUE);
  const version = pyodide.runPython(
    'import importlib.metadata; importlib.metadata.version("djlint")',
  ) as string;
  send({ type: "ready", version });
  return { pyodide, run: pyodide.globals["get"]("run") as Run };
}

const ready = boot();
// An unhandled boot rejection would kill the worker outright; runQueued() reports the same failure for each request.
// eslint-disable-next-line unicorn/prefer-await
ready.catch(() => void 0);

const mountedRoots = new Map<string, string>();

// Mounting the whole filesystem root lets djLint look for its configuration above the workspace folder, as it does when installed.
function toGuestPath({ pyodide }: Runtime, hostPath: string): string {
  const { root } = path.parse(hostPath);
  let guestRoot = mountedRoots.get(root);
  if (guestRoot == null) {
    guestRoot = `/host/${mountedRoots.size}`;
    pyodide.FS.mkdirTree(guestRoot);
    pyodide.mountNodeFS(guestRoot, root);
    mountedRoots.set(root, guestRoot);
  }
  return path.posix.join(
    guestRoot,
    ...path.relative(root, hostPath).split(path.sep),
  );
}

function execute(runtime: Runtime, request: RunRequest): string {
  const { cwd, filename, mode, options, pathOptions, src } = request;
  const guestPathOptions = Object.entries(pathOptions).map(([name, value]) => [
    name,
    toGuestPath(runtime, value),
  ]);
  return runtime.run(
    mode,
    src,
    JSON.stringify(options),
    JSON.stringify(Object.fromEntries(guestPathOptions)),
    filename,
    cwd == null ? void 0 : toGuestPath(runtime, cwd),
  );
}

const queue = new Map<number, RunRequest>();

async function runQueued(id: number): Promise<void> {
  let response: RunResponse;
  try {
    const runtime = await ready;
    // Python blocks this thread, so a cancellation sent while an earlier request ran is still in line behind its request. Let it arrive first.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const request = queue.get(id);
    if (request == null) {
      return;
    }
    response = {
      id,
      ok: true,
      output: execute(runtime, request),
      type: "result",
    };
  } catch (e) {
    response = {
      error: e instanceof Error ? e.message : String(e),
      id,
      ok: false,
      type: "result",
    };
  }
  queue.delete(id);
  send(response);
}

port.on("message", (request: WorkerRequest) => {
  if (request.type === "cancel") {
    if (queue.delete(request.id)) {
      send({ error: "cancelled", id: request.id, ok: false, type: "result" });
    }
    return;
  }
  queue.set(request.id, request);
  void runQueued(request.id);
});

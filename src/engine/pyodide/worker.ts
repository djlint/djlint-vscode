import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { LintDiagnostic } from "../types.js";
import { GLUE } from "./glue.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

// `indexURL` is the absolute path to the bundled assets/pyodide dir.
const indexURL: string = workerData.indexURL;

const ready = (async () => {
  const mod = await import(pathToFileURL(`${indexURL}/pyodide.mjs`).href);
  // Route Python stdout/stderr away from the worker's real fds (writing to them throws in a worker_thread).
  const pyodide = await mod.loadPyodide({
    indexURL,
    stderr: (text: string) => void text,
    stdout: (text: string) => void text,
  });
  // Resolves regex/pyyaml/... + the pure wheels from the local augmented lock.
  await pyodide.loadPackage("djlint");
  pyodide.runPython(GLUE);
  return {
    format: pyodide.globals.get("_djlint_format"),
    lint: pyodide.globals.get("_djlint_lint"),
    toPy: (value: unknown) => pyodide.toPy(value),
  };
})();

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  try {
    const py = await ready;
    const opts = py.toPy(req.opts);
    try {
      if (req.kind === "format") {
        const result: string = py.format(req.src, opts);
        return { id: req.id, ok: true, result };
      }
      const proxy = py.lint(req.src, opts);
      const result = proxy.toJs({
        dict_converter: Object.fromEntries,
      }) as LintDiagnostic[];
      proxy.destroy();
      return { id: req.id, ok: true, result };
    } finally {
      opts.destroy();
    }
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
      id: req.id,
      ok: false,
    };
  }
}

if (!parentPort) {
  throw new Error("pyodide worker must run as a worker_thread");
}
const port = parentPort;
port.on("message", (req: WorkerRequest) => {
  void handle(req).then((res) => {
    port.postMessage(res);
  });
});

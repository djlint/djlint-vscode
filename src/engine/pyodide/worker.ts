import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { LintDiagnostic } from "../types.js";
import { GLUE } from "./glue.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

const indexURL: string = workerData.indexURL;

function discardPythonOutput(text: string): void {
  void text;
}

const ready = (async () => {
  const mod = await import(pathToFileURL(`${indexURL}/pyodide.mjs`).href);
  const pyodide = await mod.loadPyodide({
    indexURL,
    stderr: discardPythonOutput,
    stdout: discardPythonOutput,
  });
  await pyodide.loadPackage("djlint");
  pyodide.runPython(GLUE);
  return {
    format: pyodide.globals.get("_djlint_format"),
    lint: pyodide.globals.get("_djlint_lint"),
    toPy: (value: unknown) => pyodide.toPy(value),
  };
})();

// eslint-disable-next-line unicorn/prefer-await -- an unhandled boot rejection would kill the worker outright; handle() reports the same failure per request
ready.catch(() => void 0);

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  try {
    const py = await ready;
    const opts = py.toPy(req.opts);
    try {
      if (req.kind === "format") {
        const result: string = py.format(req.src, opts);
        return { id: req.id, ok: true, result };
      }
      const proxy = py.lint(req.src, opts, req.filename);
      try {
        const result = proxy.toJs({
          dict_converter: Object.fromEntries,
        }) as LintDiagnostic[];
        return { id: req.id, ok: true, result };
      } finally {
        proxy.destroy();
      }
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

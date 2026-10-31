import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { loadPyodide, PyodideAPI } from "pyodide";
import type { WorkerData, WorkerRequest } from "./protocol.js";
import { serve } from "./runtime.js";

if (!parentPort) {
  throw new Error("pyodide worker must run as a worker_thread");
}
const port = parentPort;
const { indexURL } = workerData as WorkerData;

const mountedRoots = new Map<string, string>();

// Mounting the whole filesystem root lets djLint look for its configuration above the workspace folder, as it does when installed.
function toGuestPath(pyodide: PyodideAPI, hostPath: string): string {
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

serve({
  importPyodide: async () =>
    (await import(pathToFileURL(path.join(indexURL, "pyodide.mjs")).href)) as {
      loadPyodide: typeof loadPyodide;
    },
  indexURL,
  listen: (listener) => {
    port.on("message", (request: WorkerRequest) => {
      listener(request);
    });
  },
  send: (response) => {
    port.postMessage(response);
  },
  toGuestPath,
});

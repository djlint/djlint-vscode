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

interface NodeFilesystems {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- Emscripten's
  NODEFS: {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Emscripten's
    node_ops: { readlink: (node: unknown) => string };
  };
}

const mountedRoots = new Map<string, string>();

// The mount hands back a link's target as written on the host, which leads nowhere inside it.
function translateLinks(
  pyodide: PyodideAPI,
  toGuest: (target: string) => string,
): void {
  const nodeOperations = (pyodide.FS.filesystems as unknown as NodeFilesystems)
    .NODEFS.node_ops;
  const { readlink } = nodeOperations;
  nodeOperations.readlink = (node): string => {
    const target = readlink(node);
    if (!path.isAbsolute(target)) {
      return target.replaceAll(path.sep, "/");
    }
    try {
      return toGuest(target);
    } catch {
      return target;
    }
  };
}

// Mounting the whole filesystem root lets djLint look for its configuration above the workspace folder, as it does when installed.
function toGuestPath(pyodide: PyodideAPI, hostPath: string): string {
  const { root } = path.parse(hostPath);
  let guestRoot = mountedRoots.get(root);
  if (guestRoot == null) {
    if (mountedRoots.size === 0) {
      translateLinks(pyodide, (target) => toGuestPath(pyodide, target));
    }
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

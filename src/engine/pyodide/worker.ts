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
  NODEFS: {
    node_ops: { readlink: (node: unknown) => string };
    realPath: (node: unknown) => string;
  };
}

const mountedRoots = new Map<string, string>();

// The mount hands back a link's target as written on the host, which leads nowhere inside it.
function translateLinks(pyodide: PyodideAPI, toGuest: (target: string) => string): void {
  const { NODEFS: nodeFilesystem } = pyodide.FS.filesystems as unknown as NodeFilesystems;
  const { readlink } = nodeFilesystem.node_ops;
  nodeFilesystem.node_ops.readlink = (node): string => {
    const target = readlink(node);
    try {
      const folder = path.dirname(nodeFilesystem.realPath(node));
      return toGuest(path.resolve(folder, target));
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
    guestRoot = `/host/${mountedRoots.size}`;
    pyodide.FS.mkdirTree(guestRoot);
    pyodide.mountNodeFS(guestRoot, root);
    if (mountedRoots.size === 0) {
      translateLinks(pyodide, (target) => toGuestPath(pyodide, target));
    }
    mountedRoots.set(root, guestRoot);
  }
  return path.posix.join(guestRoot, ...path.relative(root, hostPath).split(path.sep));
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

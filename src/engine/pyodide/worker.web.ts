import type { loadPyodide } from "pyodide";
import type { WorkerData, WorkerRequest } from "./protocol.js";
import { serve } from "./runtime.js";

interface MessageEventLike<T> {
  data: T;
}

declare const self: {
  addEventListener: <T>(
    type: "message",
    listener: (event: MessageEventLike<T>) => void,
    options?: { once: boolean },
  ) => void;
  postMessage: (message: unknown) => void;
};

self.addEventListener<WorkerData>(
  "message",
  ({ data: { indexURL } }) => {
    serve({
      importPyodide: async () =>
        (await import(`${indexURL}pyodide.mjs`)) as { loadPyodide: typeof loadPyodide },
      indexURL,
      listen: (listener) => {
        self.addEventListener<WorkerRequest>("message", ({ data }) => {
          listener(data);
        });
      },
      send: (response) => {
        self.postMessage(response);
      },
      toGuestPath: (_pyodide, hostPath) => hostPath,
    });
  },
  { once: true },
);

import type { RuntimeWorker } from "./index.js";
import type { WorkerData, WorkerRequest, WorkerResponse } from "./protocol.js";

interface BrowserWorkerHandle {
  addEventListener: {
    (type: "message", listener: (event: { data: WorkerResponse }) => void): void;
    (type: "error", listener: (event: { message: string }) => void): void;
  };
  postMessage: (message: WorkerData | WorkerRequest) => void;
  terminate: () => void;
}

declare const Worker: new (url: string) => BrowserWorkerHandle;

export function createBrowserWorker(workerUrl: string, indexURL: string): RuntimeWorker {
  const worker = new Worker(workerUrl);
  worker.postMessage({ indexURL });
  return {
    onError: (listener): void => {
      worker.addEventListener("error", ({ message }) => {
        listener(new Error(message));
      });
    },
    // A browser worker only ends when it is told to.
    // oxlint-disable-next-line no-empty-function
    onExit: (): void => {},
    onMessage: (listener): void => {
      worker.addEventListener("message", ({ data }) => {
        listener(data);
      });
    },
    postMessage: (request): void => {
      worker.postMessage(request);
    },
    terminate: (): void => {
      worker.terminate();
    },
  };
}

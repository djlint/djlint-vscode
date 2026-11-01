import { Worker } from "node:worker_threads";
import type { RuntimeWorker } from "./index.js";
import type { WorkerData, WorkerResponse } from "./protocol.js";

export function createNodeWorker(workerPath: string, indexURL: string): RuntimeWorker {
  const workerData: WorkerData = { indexURL };
  const worker = new Worker(workerPath, { workerData });
  return {
    onError: (listener): void => {
      worker.on("error", listener);
    },
    onExit: (listener): void => {
      worker.on("exit", listener);
    },
    onMessage: (listener): void => {
      worker.on("message", (response: WorkerResponse) => {
        listener(response);
      });
    },
    postMessage: (request): void => {
      worker.postMessage(request);
    },
    terminate: (): void => {
      void worker.terminate();
    },
  };
}

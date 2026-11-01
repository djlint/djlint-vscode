import { EventEmitter } from "node:events";

import type {
  RunRequest,
  WorkerData,
  WorkerRequest,
  WorkerResponse,
} from "../engine/pyodide/protocol.js";

/** Replaces `Worker` via vi.mock("node:worker_threads"). */
export class FakeWorker extends EventEmitter {
  static readonly instances: FakeWorker[] = [];
  static constructionError: Error | undefined;

  readonly requests: WorkerRequest[] = [];
  terminated = false;

  constructor(
    readonly path: string,
    readonly options: { workerData: WorkerData },
  ) {
    super();
    if (FakeWorker.constructionError) {
      throw FakeWorker.constructionError;
    }
    FakeWorker.instances.push(this);
  }

  static get latest(): FakeWorker {
    const worker = FakeWorker.instances.at(-1);
    if (!worker) {
      throw new Error("no worker was started");
    }
    return worker;
  }

  static reset(): void {
    FakeWorker.instances.length = 0;
    FakeWorker.constructionError = void 0;
  }

  get runs(): RunRequest[] {
    return this.requests.filter((request) => request.type === "run");
  }

  get lastRun(): RunRequest {
    const run = this.runs.at(-1);
    if (!run) {
      throw new Error("nothing was run");
    }
    return run;
  }

  postMessage(request: WorkerRequest): void {
    this.requests.push(request);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }

  respond(response: WorkerResponse): void {
    this.emit("message", response);
  }

  succeed(id: number, output: string): void {
    this.respond({ id, ok: true, output, type: "result" });
  }

  failRun(id: number, error: string): void {
    this.respond({ error, id, ok: false, type: "result" });
  }
}

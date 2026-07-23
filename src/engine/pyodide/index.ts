import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { buildConfigKwargs } from "../kwargs.js";
import type { DjlintEngine, LintDiagnostic } from "../types.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

interface Pending {
  reject: (reason: Error) => void;
  resolve: (value: any) => void;
}

/** Runs bundled djLint inside a single warm Pyodide worker_thread, one RPC per
format/lint call keyed by an incrementing id. The worker is created lazily on
first use and reused for the engine's lifetime. */
export class PyodideEngine implements DjlintEngine {
  #worker: Worker | undefined;
  #seq = 0;
  readonly #pending = new Map<number, Pending>();

  constructor(
    private readonly workerPath: string,
    private readonly indexURL: string,
  ) {}

  async format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    return this.#call(
      "format",
      document.getText(),
      buildConfigKwargs(config, document, formattingOptions, "format"),
      token,
    );
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    return this.#call(
      "lint",
      document.getText(),
      buildConfigKwargs(config, document, void 0, "lint"),
      token,
    );
  }

  dispose(): void {
    void this.#worker?.terminate();
    this.#worker = void 0;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("djLint engine disposed"));
    }
    this.#pending.clear();
  }

  #ensure(): Worker {
    if (this.#worker) {
      return this.#worker;
    }
    const worker = new Worker(this.workerPath, {
      workerData: { indexURL: this.indexURL },
    });
    worker.on("message", (res: WorkerResponse) => {
      const pending = this.#pending.get(res.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.result);
      } else {
        pending.reject(new Error(res.error));
      }
    });
    worker.on("error", (e) => {
      for (const pending of this.#pending.values()) {
        pending.reject(e);
      }
      this.#pending.clear();
      this.#worker = void 0;
    });
    this.#worker = worker;
    return worker;
  }

  #call(
    kind: "format" | "lint",
    src: string,
    opts: Record<string, unknown>,
    token: vscode.CancellationToken,
  ): Promise<any> {
    this.#seq += 1;
    const id = this.#seq;
    const req: WorkerRequest = { id, kind, opts, src };
    return new Promise((resolve, reject) => {
      const cancel = token.onCancellationRequested(() => {
        this.#pending.delete(id);
        cancel.dispose();
        reject(new vscode.CancellationError());
      });
      this.#pending.set(id, {
        reject: (reason) => {
          cancel.dispose();
          reject(reason);
        },
        resolve: (value) => {
          cancel.dispose();
          resolve(value);
        },
      });
      this.#ensure().postMessage(req);
    });
  }
}

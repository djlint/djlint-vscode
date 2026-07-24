import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { deriveStdinFilename } from "../../stdin-filename.js";
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
  #disposed = false;
  #warnedPathOptionsIgnored = false;
  readonly #pending = new Map<number, Pending>();

  constructor(
    private readonly workerPath: string,
    private readonly indexURL: string,
    private readonly outputChannel: vscode.LogOutputChannel,
  ) {}

  async format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    this.#warnIfPathOptionsIgnored(config);
    return this.#call(
      "format",
      document.getText(),
      buildConfigKwargs(config, document, formattingOptions, "format"),
      deriveStdinFilename(document),
      token,
    );
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    this.#warnIfPathOptionsIgnored(config);
    return this.#call(
      "lint",
      document.getText(),
      buildConfigKwargs(config, document, void 0, "lint"),
      deriveStdinFilename(document),
      token,
    );
  }

  dispose(): void {
    this.#disposed = true;
    void this.#worker?.terminate();
    this.#worker = void 0;
    this.#rejectPending(new Error("djLint engine disposed"));
  }

  /** `djlint.configuration`/`djlint.rules` are host filesystem paths the
  bundled Pyodide runtime cannot read (`buildConfigKwargs()` never forwards
  them into the RPC options, see `kwargs.ts`), so setting either silently
  does nothing on this engine. Logs one reminder the first time either is
  set, rather than staying silent forever or logging on every format/lint
  call. */
  #warnIfPathOptionsIgnored(config: vscode.WorkspaceConfiguration): void {
    if (this.#warnedPathOptionsIgnored) {
      return;
    }
    const hasConfiguration = Boolean(config.get<string>("configuration"));
    const hasRules = Boolean(config.get<string>("rules"));
    if (!hasConfiguration && !hasRules) {
      return;
    }
    this.#warnedPathOptionsIgnored = true;
    this.outputChannel.info(
      "djlint.configuration and djlint.rules are ignored by the bundled djLint runtime (it has no access to the host filesystem); install djLint externally to use them.",
    );
  }

  #rejectPending(reason: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #ensure(): Worker {
    // Dispose is terminal: never resurrect a worker for a disposed engine.
    if (this.#disposed) {
      throw new vscode.CancellationError();
    }
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
      this.#rejectPending(e);
      this.#worker = void 0;
    });
    // A worker can also die WITHOUT an "error" (WebAssembly heap abort, explicit exit, bootstrap failure); without this every pending RPC would hang forever.
    worker.on("exit", (code) => {
      if (this.#disposed) {
        return;
      }
      this.#rejectPending(new Error(`djLint Pyodide worker exited (${code})`));
      this.#worker = void 0;
    });
    this.#worker = worker;
    return worker;
  }

  #call(
    kind: "format" | "lint",
    src: string,
    opts: Record<string, unknown>,
    filename: string,
    token: vscode.CancellationToken,
  ): Promise<any> {
    this.#seq += 1;
    const id = this.#seq;
    const req: WorkerRequest = { filename, id, kind, opts, src };
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

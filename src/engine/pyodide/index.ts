import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { showFailure } from "../../notify.js";
import { deriveStdinFilename } from "../../stdin-filename.js";
import { buildConfigKwargs } from "../kwargs.js";
import {
  RUN_TIMEOUT_MS,
  type DjlintEngine,
  type DjlintMode,
  type LintDiagnostic,
} from "../types.js";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
} from "./protocol.js";

interface Pending {
  stopWaiting: () => void;
  reject: (reason: Error) => void;
  resolve: (value: WorkerResult) => void;
}

export class PyodideEngine implements DjlintEngine {
  #worker: Worker | undefined;
  #seq = 0;
  #disposed = false;
  #warnedPathOptionsIgnored = false;
  readonly #pending = new Map<number, Pending>();
  readonly #reported = new Set<string>();

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
    const result = await this.#call(
      "format",
      document.getText(),
      buildConfigKwargs(config, formattingOptions, "format"),
      deriveStdinFilename(document),
      token,
    );
    if (typeof result !== "string") {
      throw new TypeError("Bundled djLint runtime returned no formatted text");
    }
    return result;
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    this.#warnIfPathOptionsIgnored(config);
    const result = await this.#call(
      "lint",
      document.getText(),
      buildConfigKwargs(config, void 0, "lint"),
      deriveStdinFilename(document),
      token,
    );
    if (typeof result === "string") {
      throw new TypeError("Bundled djLint runtime returned no diagnostics");
    }
    return result;
  }

  dispose(): void {
    this.#disposed = true;
    this.#discardWorker(new Error("djLint engine disposed"));
  }

  #warnIfPathOptionsIgnored(config: vscode.WorkspaceConfiguration): void {
    if (this.#warnedPathOptionsIgnored) {
      return;
    }
    const hasPathOptions =
      Boolean(config.get<string>("configuration")) ||
      Boolean(config.get<string>("rules"));
    if (!hasPathOptions) {
      return;
    }
    this.#warnedPathOptionsIgnored = true;
    this.outputChannel.info(
      "djlint.configuration and djlint.rules are ignored by the bundled djLint runtime (it has no access to the host filesystem); install djLint externally to use them.",
    );
  }

  #report(message: string): void {
    this.outputChannel.error(message);
    if (this.#reported.has(message)) {
      return;
    }
    this.#reported.add(message);
    void showFailure(message, this.outputChannel);
  }

  #take(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (pending) {
      this.#pending.delete(id);
      pending.stopWaiting();
    }
    return pending;
  }

  #rejectPending(reason: Error): void {
    const abandoned = this.#pending.values().toArray();
    this.#pending.clear();
    for (const pending of abandoned) {
      pending.stopWaiting();
      pending.reject(reason);
    }
  }

  #discardWorker(reason: Error): void {
    const worker = this.#worker;
    this.#worker = void 0;
    void worker?.terminate();
    this.#rejectPending(reason);
  }

  #ensure(): Worker {
    if (this.#disposed) {
      throw new vscode.CancellationError();
    }
    if (this.#worker) {
      return this.#worker;
    }
    const worker = new Worker(this.workerPath, {
      workerData: { indexURL: this.indexURL },
    });
    const isCurrent = (): boolean => this.#worker === worker;
    worker.on("message", (res: WorkerResponse) => {
      const pending = this.#take(res.id);
      if (!pending) {
        return;
      }
      if (res.ok) {
        pending.resolve(res.result);
      } else {
        this.#report(`Bundled djLint runtime error: ${res.error}`);
        pending.reject(new Error(res.error));
      }
    });
    worker.on("error", (e) => {
      if (!isCurrent()) {
        return;
      }
      this.#report(`Bundled djLint runtime failed: ${e.message}`);
      this.#worker = void 0;
      this.#rejectPending(e);
    });
    worker.on("exit", (code) => {
      if (this.#disposed || !isCurrent()) {
        return;
      }
      this.#worker = void 0;
      this.#report(`Bundled djLint runtime exited unexpectedly (${code})`);
      this.#rejectPending(new Error(`Bundled djLint runtime exited (${code})`));
    });
    this.#worker = worker;
    return worker;
  }

  #call(
    kind: DjlintMode,
    src: string,
    opts: Record<string, unknown>,
    filename: string,
    token: vscode.CancellationToken,
  ): Promise<WorkerResult> {
    this.#seq += 1;
    const id = this.#seq;
    const req: WorkerRequest = { filename, id, kind, opts, src };
    return new Promise((resolve, reject) => {
      if (token.isCancellationRequested) {
        reject(new vscode.CancellationError());
        return;
      }
      const timer = setTimeout(() => {
        this.#report(
          `Bundled djLint runtime did not respond within ${RUN_TIMEOUT_MS / 1000} seconds; restarting it.`,
        );
        this.#discardWorker(new Error("Bundled djLint runtime timed out"));
      }, RUN_TIMEOUT_MS);
      const cancellation = token.onCancellationRequested(() => {
        this.#take(id)?.reject(new vscode.CancellationError());
      });
      this.#pending.set(id, {
        reject,
        resolve,
        stopWaiting: () => {
          clearTimeout(timer);
          cancellation.dispose();
        },
      });
      try {
        this.#ensure().postMessage(req);
      } catch (e) {
        this.#take(id)?.reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

import path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { formattingArgs, lintingArgs, type ArgContext } from "../../args.js";
import { lastLine, showFailure } from "../../notify.js";
import { deriveStdinFilename, getDocumentFolder } from "../../paths.js";
import type { DjlintStatus } from "../../status.js";
import {
  RUN_TIMEOUT_MS,
  type DjlintEngine,
  type DjlintMode,
  type LintDiagnostic,
} from "../types.js";
import type {
  RunRequest,
  RunResponse,
  WorkerData,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";

interface Pending {
  isCancelled: boolean;
  stopWaiting: () => void;
  reject: (reason: Error) => void;
  resolve: (output: string) => void;
}

function buildOptions(
  context: ArgContext,
  mode: DjlintMode,
): Pick<RunRequest, "options" | "pathOptions"> {
  const options: RunRequest["options"] = {};
  const pathOptions: RunRequest["pathOptions"] = {};
  const args = mode === "format" ? formattingArgs : lintingArgs;
  for (const arg of args) {
    const kwarg = arg.buildKwarg(context);
    if (kwarg == null) {
      continue;
    }
    const [name, value] = kwarg;
    if (!arg.isPath) {
      options[name] = value;
    } else if (typeof value === "string" && path.isAbsolute(value)) {
      pathOptions[name] = value;
    }
  }
  return { options, pathOptions };
}

export class PyodideEngine implements DjlintEngine {
  #worker: Worker | undefined;
  #seq = 0;
  #disposed = false;
  #version = "";
  readonly #pending = new Map<number, Pending>();
  readonly #reported = new Set<string>();

  constructor(
    private readonly workerPath: string,
    private readonly indexURL: string,
    private readonly outputChannel: vscode.LogOutputChannel,
    private readonly canReadProjectFiles: boolean,
    private readonly status: DjlintStatus,
  ) {}

  async format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    return this.#call("format", { config, document, formattingOptions }, token);
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    const output = await this.#call("lint", { config, document }, token);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- written by glue.py
    return JSON.parse(output) as LintDiagnostic[];
  }

  dispose(): void {
    this.#disposed = true;
    this.#discardWorker(new Error("djLint engine disposed"));
  }

  #report(message: string): void {
    if (this.#reported.has(message)) {
      return;
    }
    this.#reported.add(message);
    void showFailure(message, this.outputChannel);
  }

  #take(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) {
      return void 0;
    }
    this.#pending.delete(id);
    pending.stopWaiting();
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

  #settle(response: RunResponse): void {
    const pending = this.#take(response.id);
    if (!pending) {
      return;
    }
    if (response.ok) {
      this.status.update(this.#version, "bundled");
      pending.resolve(response.output);
    } else if (!pending.isCancelled) {
      this.outputChannel.error(response.error);
      this.#report(
        `Bundled djLint failed: ${lastLine(response.error) ?? response.error}`,
      );
      pending.reject(new Error(response.error));
    }
  }

  #fail(message: string, reason: Error): void {
    this.outputChannel.error(message);
    this.#report(message);
    this.#discardWorker(reason);
  }

  #ensureWorker(): Worker {
    if (this.#disposed) {
      throw new vscode.CancellationError();
    }
    if (this.#worker) {
      return this.#worker;
    }
    const workerData: WorkerData = { indexURL: this.indexURL };
    const worker = new Worker(this.workerPath, { workerData });
    const isCurrent = (): boolean => this.#worker === worker;
    worker.on("message", (response: WorkerResponse) => {
      if (response.type === "log") {
        this.outputChannel[response.level](response.line);
      } else if (response.type === "ready") {
        this.#version = response.version;
        this.outputChannel.info(`Using the bundled djLint ${response.version}`);
      } else {
        this.#settle(response);
      }
    });
    worker.on("error", (e) => {
      if (isCurrent()) {
        this.#fail(`Bundled djLint runtime failed: ${e.message}`, e);
      }
    });
    worker.on("exit", (code) => {
      if (!isCurrent()) {
        return;
      }
      const message = `Bundled djLint runtime exited unexpectedly (${code})`;
      this.#fail(message, new Error(message));
    });
    this.#worker = worker;
    return worker;
  }

  #call(
    mode: DjlintMode,
    context: ArgContext,
    token: vscode.CancellationToken,
  ): Promise<string> {
    this.#seq += 1;
    const id = this.#seq;
    const { document } = context;
    const { options, pathOptions } = buildOptions(context, mode);
    const request: RunRequest = {
      cwd: this.canReadProjectFiles ? getDocumentFolder(document) : void 0,
      filename: deriveStdinFilename(document),
      id,
      mode,
      options,
      pathOptions: this.canReadProjectFiles ? pathOptions : {},
      src: document.getText(),
      type: "run",
    };
    return new Promise((resolve, reject) => {
      if (token.isCancellationRequested) {
        reject(new vscode.CancellationError());
        return;
      }
      const timer = setTimeout(() => {
        this.#fail(
          `Bundled djLint did not respond within ${RUN_TIMEOUT_MS / 1000} seconds; restarting it.`,
          new Error("Bundled djLint timed out"),
        );
      }, RUN_TIMEOUT_MS);
      // Python blocks the worker, so the run is only over once it says so. Until then the timer stays armed: nothing else can end a stuck run.
      const cancellation = token.onCancellationRequested(() => {
        const pending = this.#pending.get(id);
        if (!pending) {
          return;
        }
        pending.isCancelled = true;
        pending.reject(new vscode.CancellationError());
        const cancel: WorkerRequest = { id, type: "cancel" };
        this.#worker?.postMessage(cancel);
      });
      this.#pending.set(id, {
        isCancelled: false,
        reject,
        resolve,
        stopWaiting: () => {
          clearTimeout(timer);
          cancellation.dispose();
        },
      });
      try {
        this.#ensureWorker().postMessage(request);
      } catch (e) {
        this.#take(id)?.reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

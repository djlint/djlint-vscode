import path from "node:path";

import * as vscode from "vscode";

import { buildOptions } from "../../args.js";
import type { ArgContext } from "../../args.js";
import { lastLine, showFailure } from "../../notify.js";
import { deriveStdinFilename } from "../../paths.js";
import type { DjlintStatus } from "../../status.js";
import { RUN_TIMEOUT_MS } from "../types.js";
import type { DjlintEngine, DjlintMode, LintDiagnostic } from "../types.js";
import { readProject } from "./project.js";
import type { RunRequest, RunResponse, WorkerRequest, WorkerResponse } from "./protocol.js";

export interface RuntimeWorker {
  onError: (listener: (e: Error) => void) => void;
  onExit: (listener: (code: number) => void) => void;
  onMessage: (listener: (response: WorkerResponse) => void) => void;
  postMessage: (request: WorkerRequest) => void;
  terminate: () => void;
}

interface Pending {
  document: vscode.TextDocument;
  isCancelled: boolean;
  stopListening: () => void;
  reject: (reason: Error) => void;
  resolve: (output: string) => void;
}

type ProjectLocation = Pick<RunRequest, "cwd" | "pathOptions" | "project">;

function absoluteOnly(pathOptions: RunRequest["pathOptions"]): RunRequest["pathOptions"] {
  return Object.fromEntries(
    Object.entries(pathOptions).filter(([, value]) => path.isAbsolute(value)),
  );
}

export class PyodideEngine implements DjlintEngine {
  #worker: RuntimeWorker | undefined;
  #seq = 0;
  #disposed = false;
  #version = "";
  #watchdog: ReturnType<typeof setTimeout> | undefined;
  readonly #pending = new Map<number, Pending>();
  readonly #reported = new Set<string>();
  readonly #createWorker: () => RuntimeWorker;
  readonly #outputChannel: vscode.LogOutputChannel;
  readonly #canReadProjectFiles: boolean;
  readonly #status: DjlintStatus;
  readonly #getHostFolder: (document: vscode.TextDocument) => string | undefined;

  constructor(
    createWorker: () => RuntimeWorker,
    outputChannel: vscode.LogOutputChannel,
    canReadProjectFiles: boolean,
    status: DjlintStatus,
    getHostFolder: (document: vscode.TextDocument) => string | undefined,
  ) {
    this.#createWorker = createWorker;
    this.#outputChannel = outputChannel;
    this.#canReadProjectFiles = canReadProjectFiles;
    this.#status = status;
    this.#getHostFolder = getHostFolder;
  }

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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by glue.py
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
    void showFailure(message, this.#outputChannel);
  }

  // Python blocks the worker, so silence is the only sign of a stuck run, and only this can end one. Each answer resets it, so a long queue is not mistaken for that, and a cancelled run stays watched until its answer arrives.
  #watch(): void {
    clearTimeout(this.#watchdog);
    this.#watchdog =
      this.#pending.size === 0
        ? void 0
        : setTimeout(() => {
            this.#fail(
              `Bundled djLint did not respond within ${RUN_TIMEOUT_MS / 1000} seconds; restarting it.`,
              new Error("Bundled djLint timed out"),
            );
          }, RUN_TIMEOUT_MS);
  }

  #take(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) {
      return void 0;
    }
    this.#pending.delete(id);
    pending.stopListening();
    return pending;
  }

  #rejectPending(reason: Error): void {
    const abandoned = this.#pending.values().toArray();
    this.#pending.clear();
    for (const pending of abandoned) {
      pending.stopListening();
      pending.reject(reason);
    }
    this.#watch();
  }

  #discardWorker(reason: Error): void {
    const worker = this.#worker;
    this.#worker = void 0;
    worker?.terminate();
    this.#rejectPending(reason);
  }

  #settle(response: RunResponse): void {
    const pending = this.#take(response.id);
    if (!pending) {
      return;
    }
    if (response.ok) {
      this.#status.update(pending.document, this.#version, "bundled");
      pending.resolve(response.output);
    } else if (!pending.isCancelled) {
      this.#outputChannel.error(response.error);
      this.#report(`Bundled djLint failed: ${lastLine(response.error) ?? response.error}`);
      pending.reject(new Error(response.error));
    }
  }

  #fail(message: string, reason: Error): void {
    this.#outputChannel.error(message);
    this.#report(message);
    this.#discardWorker(reason);
  }

  #receive(response: WorkerResponse): void {
    this.#handle(response);
    this.#watch();
  }

  #handle(response: WorkerResponse): void {
    // oxlint-disable-next-line default-case -- every type has a case
    switch (response.type) {
      case "boot-failed": {
        this.#outputChannel.error(response.error);
        const reason = lastLine(response.error) ?? response.error;
        const message = `Bundled djLint runtime failed to start: ${reason}`;
        this.#fail(message, new Error(message));
        break;
      }
      case "crashed": {
        this.#outputChannel.error(response.error);
        const reason = lastLine(response.error) ?? response.error;
        const message = `Bundled djLint runtime crashed: ${reason}`;
        this.#fail(message, new Error(message));
        break;
      }
      case "log": {
        this.#outputChannel[response.level](response.line);
        break;
      }
      case "ready": {
        this.#version = response.version;
        this.#outputChannel.info(`Using the bundled djLint ${response.version}`);
        break;
      }
      case "result": {
        this.#settle(response);
        break;
      }
    }
  }

  #ensureWorker(): RuntimeWorker {
    if (this.#disposed) {
      throw new vscode.CancellationError();
    }
    if (this.#worker) {
      return this.#worker;
    }
    const worker = this.#createWorker();
    const isCurrent = (): boolean => this.#worker === worker;
    worker.onMessage((response) => {
      if (isCurrent()) {
        this.#receive(response);
      }
    });
    worker.onError((e) => {
      if (isCurrent()) {
        this.#fail(`Bundled djLint runtime failed: ${e.message}`, e);
      }
    });
    worker.onExit((code) => {
      if (!isCurrent()) {
        return;
      }
      const message = `Bundled djLint runtime exited unexpectedly (${code})`;
      this.#fail(message, new Error(message));
    });
    this.#worker = worker;
    return worker;
  }

  // Sync where it can be: a request for a local file reaches the worker with no delay.
  #locateOnHost(
    document: vscode.TextDocument,
    pathOptions: RunRequest["pathOptions"],
  ): ProjectLocation | undefined {
    if (!this.#canReadProjectFiles) {
      return { cwd: void 0, pathOptions: {}, project: void 0 };
    }
    const hostFolder = this.#getHostFolder(document);
    return hostFolder == null
      ? void 0
      : { cwd: hostFolder, pathOptions: absoluteOnly(pathOptions), project: void 0 };
  }

  async #call(
    mode: DjlintMode,
    context: ArgContext,
    token: vscode.CancellationToken,
  ): Promise<string> {
    this.#seq += 1;
    const id = this.#seq;
    const { document } = context;
    const { options, pathOptions } = buildOptions(context, mode);
    const request: RunRequest = {
      ...(this.#locateOnHost(document, pathOptions) ??
        (await readProject(document, pathOptions, this.#outputChannel)) ?? {
          cwd: void 0,
          pathOptions: absoluteOnly(pathOptions),
          project: void 0,
        }),
      // The absolute path that per-file-ignores and rule modules get from the command line and the language server.
      filename:
        this.#canReadProjectFiles && document.uri.scheme === "file"
          ? document.uri.fsPath.replaceAll("\\", "/")
          : deriveStdinFilename(document),
      id,
      mode,
      options,
      src: document.getText(),
      type: "run",
    };
    return new Promise((resolve, reject) => {
      if (token.isCancellationRequested) {
        reject(new vscode.CancellationError());
        return;
      }
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
        document,
        isCancelled: false,
        reject,
        resolve,
        stopListening: () => {
          cancellation.dispose();
        },
      });
      if (this.#watchdog == null) {
        this.#watch();
      }
      try {
        this.#ensureWorker().postMessage(request);
      } catch (e) {
        this.#take(id)?.reject(e instanceof Error ? e : new Error(String(e)));
        this.#watch();
      }
    });
  }
}

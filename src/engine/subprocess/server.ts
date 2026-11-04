/* oxlint-disable typescript/no-unsafe-type-assertion -- what the server sends is the protocol's */
import { execa } from "execa";
import * as vscode from "vscode";
import {
  createMessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { MessageConnection } from "vscode-jsonrpc/node";
import type { Diagnostic, TextEdit } from "vscode-languageserver-types";

import { showFailure } from "../../notify.js";
import { RUN_TIMEOUT_MS } from "../types.js";
import type { LintDiagnostic } from "../types.js";

const REQUEST_CANCELLED = -32_800;
const LOG_ERROR = 1;
const LOG_WARNING = 2;
const STOP_TIMEOUT_MS = 1000;
const CANCEL_GRACE_MS = 1000;
// Windows keeps a running environment's files locked, which stops `pip install` and `uv sync` in it.
// Elsewhere a server waits out a pause in work, as starting one takes most of a second, but one of a djLint since upgraded is never used again.
export const IDLE_STOP_MS = process.platform === "win32" ? 30_000 : 600_000;

export type ServerSettings = Record<string, unknown>;

// The type of what execa returns depends on these options.
// oxlint-disable-next-line typescript/explicit-function-return-type, typescript/promise-function-async
function spawnServer(exec: string, prefixArgs: readonly string[], cwd: string | undefined) {
  return execa(exec, [...prefixArgs, "--lsp"], {
    buffer: false,
    ...(cwd != null && { cwd }),
    reject: false,
  });
}

export function applyEdits(document: vscode.TextDocument, edits: readonly TextEdit[]): string {
  const text = document.getText();
  return edits
    .map(({ newText, range }) => ({
      end: document.offsetAt(new vscode.Position(range.end.line, range.end.character)),
      newText,
      start: document.offsetAt(new vscode.Position(range.start.line, range.start.character)),
    }))
    .toSorted((a, b) => b.start - a.start)
    .reduce(
      (result, { end, newText, start }) => result.slice(0, start) + newText + result.slice(end),
      text,
    );
}

function toLintDiagnostic({ code = "", message, range }: Diagnostic): LintDiagnostic {
  return {
    code: String(code),
    column: range.start.character,
    endColumn: range.end.character,
    endLine: range.end.line + 1,
    isUtf16: true,
    line: range.start.line + 1,
    // Since LSP 3.18 a message can be markup, which djLint doesn't send.
    message: typeof message === "string" ? message : message.value,
  };
}

/** The server's answer to a run, which says nothing about the runs after it. */
export class ServerResponseError extends Error {
  override name = "ServerResponseError";
}

/** `djlint --lsp`, running once instead of a process for every format and lint. */
export class DjlintServer {
  #queue: Promise<unknown> = Promise.resolve();
  #isClosed = false;
  #isStopping = false;
  #running = 0;
  #idleTimer: NodeJS.Timeout | undefined;
  readonly #shownMessages = new Set<string>();
  // What fails each request still waiting, with the reason the server closed.
  readonly #waiting = new Set<(reason: Error) => void>();
  readonly #connection: MessageConnection;
  readonly #process: ReturnType<typeof spawnServer>;
  readonly #outputChannel: vscode.LogOutputChannel;
  readonly #started: Promise<unknown>;
  readonly #version: string;

  constructor(
    exec: string,
    prefixArgs: readonly string[],
    cwd: string | undefined,
    version: string,
    outputChannel: vscode.LogOutputChannel,
  ) {
    this.#outputChannel = outputChannel;
    this.#version = version;
    this.#process = spawnServer(exec, prefixArgs, cwd);
    const reader = new StreamMessageReader(this.#process.stdout);
    // Its timer for a message that stops halfway would outlive the server; the request timeout covers that.
    reader.partialMessageTimeout = 0;
    const writer = new StreamMessageWriter(this.#process.stdin);
    reader.onError(() => {
      this.#close(new Error("djLint's language server sent a bad message"));
    });
    writer.onError(() => {
      this.#close(new Error("djLint's language server closed its input"));
    });
    const log = (message: string): void => {
      this.#outputChannel.debug(message);
    };
    this.#connection = createMessageConnection(reader, writer, {
      error: log,
      info: log,
      log,
      warn: log,
    });
    this.#connection.onNotification(
      "window/logMessage",
      ({ message, type }: { message: string; type: number }) => {
        if (type === LOG_ERROR) {
          this.#outputChannel.error(message);
        } else if (type === LOG_WARNING) {
          this.#outputChannel.warn(message);
        } else {
          this.#outputChannel.info(message);
        }
      },
    );
    this.#connection.onNotification("window/showMessage", ({ message }: { message: string }) => {
      if (!this.#shownMessages.has(message)) {
        this.#shownMessages.add(message);
        void showFailure(message, this.#outputChannel);
      }
    });
    // A request this client has no use for, such as `workspace/configuration`, gets an empty answer.
    this.#connection.onRequest(() => null);
    this.#connection.listen();
    this.#process.stderr.setEncoding("utf8");
    this.#process.stderr.on("data", (chunk: string) => {
      this.#outputChannel.debug(chunk.trimEnd());
    });
    // oxlint-disable-next-line promise/always-return, promise/prefer-await-to-then -- nothing waits for the server to end
    void this.#process.then(() => {
      this.#close(new Error("djLint's language server ended"));
    });
    this.#started = this.#initialize();
    // A run that ends before it needs the server never looks at this.
    void Promise.allSettled([this.#started]);
  }

  /**
   * Whether it takes no more work, for any reason.
   * @returns `true` once the server has closed or was told to stop.
   */
  get isClosed(): boolean {
    return this.#isClosed || this.#isStopping;
  }

  /**
   * Whether it was told to stop, which says nothing against the server.
   * @returns `true` once `dispose` is called, or once a cancelled run outlasts its grace period.
   */
  get isStopping(): boolean {
    return this.#isStopping;
  }

  async format(
    document: vscode.TextDocument,
    settings: ServerSettings,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const { version } = document;
    const edits = await this.#withDocument(document, settings, token, "textDocument/formatting", {
      options: formattingOptions,
      textDocument: { uri: document.uri.toString() },
    });
    // The edits are for the text the server got.
    if (document.version !== version) {
      throw new vscode.CancellationError();
    }
    return applyEdits(document, (edits ?? []) as readonly TextEdit[]);
  }

  async lint(
    document: vscode.TextDocument,
    settings: ServerSettings,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    const report = (await this.#withDocument(document, settings, token, "textDocument/diagnostic", {
      textDocument: { uri: document.uri.toString() },
    })) as { items?: Diagnostic[] };
    return (report.items ?? []).map((item) => toLintDiagnostic(item));
  }

  dispose(): void {
    clearTimeout(this.#idleTimer);
    if (this.isClosed) {
      return;
    }
    this.#isStopping = true;
    void this.#stop();
  }

  async #initialize(): Promise<void> {
    const { serverInfo } = (await this.#request("initialize", {
      capabilities: { textDocument: { diagnostic: {} } },
      processId: process.pid,
      rootUri: null,
      workspaceFolders: null,
    })) as { serverInfo?: { version?: string } };
    // A version manager's shim can pick another djLint in the folder the server runs from.
    if (serverInfo?.version !== this.#version) {
      throw new Error(
        `the language server is djLint ${serverInfo?.version ?? "of unknown version"}, not ${this.#version}`,
      );
    }
    this.#notify("initialized", {});
  }

  async #stop(): Promise<void> {
    const timer = setTimeout(() => {
      this.#process.kill();
    }, STOP_TIMEOUT_MS);
    try {
      await this.#request("shutdown");
      this.#notify("exit");
      await this.#process;
    } catch {
      this.#process.kill();
    } finally {
      clearTimeout(timer);
    }
  }

  // One document at a time: the server takes one at a time too, and a document is only open for its request.
  async #withDocument(
    document: vscode.TextDocument,
    settings: ServerSettings,
    token: vscode.CancellationToken,
    method: string,
    params: object,
  ): Promise<unknown> {
    const previous = this.#queue;
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.#queue = promise;
    clearTimeout(this.#idleTimer);
    this.#running += 1;
    try {
      await previous;
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      if (this.#isStopping) {
        throw new Error("djLint's language server is stopping");
      }
      await this.#untilStarted(token);
      // Sent for each run, as it also has the server import custom rules anew, as a new process would.
      this.#notify("workspace/didChangeConfiguration", { settings: { djlint: settings } });
      const uri = document.uri.toString();
      this.#notify("textDocument/didOpen", {
        textDocument: {
          // Not the document's: the server would choose a profile by it, which the command line and the bundled djLint don't.
          languageId: "",
          text: document.getText(),
          uri,
          version: document.version,
        },
      });
      try {
        return await this.#request(method, params, token);
      } finally {
        this.#notify("textDocument/didClose", { textDocument: { uri } });
      }
    } finally {
      resolve(void 0);
      this.#running -= 1;
      if (this.#running === 0) {
        this.#idleTimer = setTimeout(() => {
          this.dispose();
        }, IDLE_STOP_MS).unref();
      }
    }
  }

  async #untilStarted(token: vscode.CancellationToken): Promise<void> {
    const { promise, reject } = Promise.withResolvers<never>();
    const cancellation = token.onCancellationRequested(() => {
      reject(new vscode.CancellationError());
    });
    try {
      await Promise.race([this.#started, promise]);
    } finally {
      cancellation.dispose();
    }
  }

  #notify(method: string, params?: object): void {
    if (this.#isClosed) {
      return;
    }
    // A notification that cannot be written closes the server through the writer's error.
    const sent =
      params == null
        ? this.#connection.sendNotification(method)
        : this.#connection.sendNotification(method, params);
    void Promise.allSettled([sent]);
  }

  async #request(
    method: string,
    params?: object,
    token?: vscode.CancellationToken,
  ): Promise<unknown> {
    if (this.#isClosed) {
      throw new Error("djLint's language server has ended");
    }
    const timer = setTimeout(() => {
      this.#close(new Error(`djLint's language server timed out on ${method}`));
    }, RUN_TIMEOUT_MS);
    let cancelTimer: NodeJS.Timeout | undefined;
    // The connection asks the server to cancel; the server only cancels what it hasn't started, and a stuck run would hold up all that follows.
    const cancellation = token?.onCancellationRequested(() => {
      cancelTimer = setTimeout(() => {
        this.#isStopping = true;
        this.#close(new vscode.CancellationError());
      }, CANCEL_GRACE_MS);
    });
    // One for each request: a promise that outlived them all would keep every answer it raced.
    const closed = Promise.withResolvers<never>();
    this.#waiting.add(closed.reject);
    try {
      return await Promise.race([this.#send(method, params, token), closed.promise]);
    } catch (e) {
      if (e instanceof ResponseError) {
        throw e.code === REQUEST_CANCELLED
          ? new vscode.CancellationError()
          : new ServerResponseError(e.message);
      }
      throw e;
    } finally {
      this.#waiting.delete(closed.reject);
      clearTimeout(timer);
      clearTimeout(cancelTimer);
      cancellation?.dispose();
    }
  }

  // The connection takes a trailing cancellation token as the token, and anything else as a parameter.
  async #send(method: string, params?: object, token?: vscode.CancellationToken): Promise<unknown> {
    if (params == null) {
      return this.#connection.sendRequest(method);
    }
    if (token == null) {
      return this.#connection.sendRequest(method, params);
    }
    return this.#connection.sendRequest(method, params, token);
  }

  #close(reason: Error): void {
    if (this.#isClosed) {
      return;
    }
    this.#isClosed = true;
    for (const reject of this.#waiting) {
      reject(reason);
    }
    this.#waiting.clear();
    this.#connection.dispose();
    this.#process.kill();
  }
}

/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- what the server sends is the protocol's */
import { execa } from "execa";
import * as vscode from "vscode";
import { showFailure } from "../../notify.js";
import { RUN_TIMEOUT_MS, type LintDiagnostic } from "../types.js";

const HEADER_END = Buffer.from("\r\n\r\n");
const CONTENT_LENGTH_REGEX = /^content-length:\s*(?<length>\d+)/imu;
const REQUEST_CANCELLED = -32_800;
const LOG_ERROR = 1;
const LOG_WARNING = 2;
const STOP_TIMEOUT_MS = 1000;
const CANCEL_GRACE_MS = 1000;
// Windows keeps a running environment's files locked, which stops `pip install` and `uv sync` in it.
// Elsewhere a server waits out a pause in work, as starting one takes most of a second, but one of a djLint since upgraded is never used again.
export const IDLE_STOP_MS = process.platform === "win32" ? 30_000 : 600_000;

interface Position {
  character: number;
  line: number;
}

interface Range {
  end: Position;
  start: Position;
}

interface Diagnostic {
  code?: number | string;
  message: string;
  range: Range;
}

interface TextEdit {
  newText: string;
  range: Range;
}

interface Message {
  error?: { code: number; message: string };
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
}

interface Waiter {
  reject: (reason: Error) => void;
  resolve: (result: unknown) => void;
}

export type ServerSettings = Record<string, unknown>;

// The type of what execa returns depends on these options.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/promise-function-async
function spawnServer(
  exec: string,
  prefixArgs: readonly string[],
  cwd: string | undefined,
) {
  return execa(exec, [...prefixArgs, "--lsp"], {
    buffer: false,
    ...(cwd != null && { cwd }),
    reject: false,
  });
}

export function applyEdits(
  document: vscode.TextDocument,
  edits: readonly TextEdit[],
): string {
  const text = document.getText();
  return edits
    .map(({ newText, range }) => ({
      end: document.offsetAt(
        new vscode.Position(range.end.line, range.end.character),
      ),
      newText,
      start: document.offsetAt(
        new vscode.Position(range.start.line, range.start.character),
      ),
    }))
    .toSorted((a, b) => b.start - a.start)
    .reduce(
      (result, { end, newText, start }) =>
        result.slice(0, start) + newText + result.slice(end),
      text,
    );
}

function toLintDiagnostic({
  code = "",
  message,
  range,
}: Diagnostic): LintDiagnostic {
  return {
    code: String(code),
    column: range.start.character,
    endColumn: range.end.character,
    endLine: range.end.line + 1,
    isUtf16: true,
    line: range.start.line + 1,
    message,
  };
}

/** The server's answer to a run, which says nothing about the runs after it. */
export class ServerResponseError extends Error {
  override name = "ServerResponseError";
}

/** `djlint --lsp`, running once instead of a process for every format and lint. */
export class DjlintServer {
  #nextId = 0;
  #buffer = Buffer.alloc(0);
  #queue: Promise<unknown> = Promise.resolve();
  #isClosed = false;
  #isStopping = false;
  #running = 0;
  #idleTimer: NodeJS.Timeout | undefined;
  readonly #waiters = new Map<number, Waiter>();
  readonly #shownMessages = new Set<string>();
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
    this.#process.stdout.on("data", (chunk: Buffer) => {
      this.#receive(chunk);
    });
    this.#process.stderr.setEncoding("utf8");
    this.#process.stderr.on("data", (chunk: string) => {
      this.#outputChannel.debug(chunk.trimEnd());
    });
    this.#process.stdin.on("error", () => {
      this.#close(new Error("djLint's language server closed its input"));
    });
    void this.#process.then(() => {
      this.#close(new Error("djLint's language server ended"));
    });
    this.#started = this.#initialize();
    // A run that ends before it needs the server never looks at this.
    void Promise.allSettled([this.#started]);
  }

  /** Whether it takes no more work, for any reason. */
  get isClosed(): boolean {
    return this.#isClosed || this.#isStopping;
  }

  /** Whether it was told to stop, which says nothing against the server. */
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
    const edits = await this.#withDocument(
      document,
      settings,
      token,
      "textDocument/formatting",
      {
        options: formattingOptions,
        textDocument: { uri: document.uri.toString() },
      },
    );
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
    const report = (await this.#withDocument(
      document,
      settings,
      token,
      "textDocument/diagnostic",
      { textDocument: { uri: document.uri.toString() } },
    )) as { items?: Diagnostic[] };
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
      await this.#request("shutdown", null);
      this.#notify("exit", null);
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
    params: unknown,
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
      this.#notify("workspace/didChangeConfiguration", {
        settings: { djlint: settings },
      });
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

  #write(message: object): void {
    if (this.#isClosed) {
      return;
    }
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", ...message }),
      "utf8",
    );
    this.#process.stdin.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
        body,
      ]),
    );
  }

  #notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  async #request(
    method: string,
    params: unknown,
    token?: vscode.CancellationToken,
  ): Promise<unknown> {
    if (this.#isClosed) {
      throw new Error("djLint's language server has ended");
    }
    this.#nextId += 1;
    const id = this.#nextId;
    const { promise, reject, resolve } = Promise.withResolvers<unknown>();
    this.#waiters.set(id, { reject, resolve });
    const timer = setTimeout(() => {
      this.#close(new Error(`djLint's language server timed out on ${method}`));
    }, RUN_TIMEOUT_MS);
    let cancelTimer: NodeJS.Timeout | undefined;
    const cancellation = token?.onCancellationRequested(() => {
      this.#notify("$/cancelRequest", { id });
      // The server only cancels what it hasn't started, and a stuck run would hold up all that follows.
      cancelTimer = setTimeout(() => {
        this.#isStopping = true;
        this.#close(new vscode.CancellationError());
      }, CANCEL_GRACE_MS);
    });
    this.#write({ id, method, params });
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
      clearTimeout(cancelTimer);
      cancellation?.dispose();
    }
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const headerEnd = this.#buffer.indexOf(HEADER_END);
      if (headerEnd === -1) {
        return;
      }
      const header = this.#buffer.toString("ascii", 0, headerEnd);
      const length = CONTENT_LENGTH_REGEX.exec(header)?.groups?.["length"];
      const bodyStart = headerEnd + HEADER_END.length;
      const bodyEnd = bodyStart + Number(length);
      if (length == null) {
        this.#close(new Error("djLint's language server sent a bad message"));
        return;
      }
      if (this.#buffer.length < bodyEnd) {
        return;
      }
      const body = this.#buffer.toString("utf8", bodyStart, bodyEnd);
      this.#buffer = this.#buffer.subarray(bodyEnd);
      let message: Message;
      try {
        message = JSON.parse(body) as Message;
      } catch {
        this.#close(new Error("djLint's language server sent a bad message"));
        return;
      }
      this.#handle(message);
    }
  }

  #handle(message: Message): void {
    if (message.method != null) {
      this.#handleServerMessage(message);
      return;
    }
    const waiter = this.#waiters.get(Number(message.id));
    if (waiter == null) {
      return;
    }
    this.#waiters.delete(Number(message.id));
    if (message.error == null) {
      waiter.resolve(message.result);
    } else if (message.error.code === REQUEST_CANCELLED) {
      waiter.reject(new vscode.CancellationError());
    } else {
      waiter.reject(new ServerResponseError(message.error.message));
    }
  }

  #handleServerMessage({ id, method, params }: Message): void {
    if (method === "window/logMessage") {
      const { message, type } = params as { message: string; type: number };
      if (type === LOG_ERROR) {
        this.#outputChannel.error(message);
      } else if (type === LOG_WARNING) {
        this.#outputChannel.warn(message);
      } else {
        this.#outputChannel.info(message);
      }
    } else if (method === "window/showMessage") {
      const { message } = params as { message: string };
      if (!this.#shownMessages.has(message)) {
        this.#shownMessages.add(message);
        void showFailure(message, this.#outputChannel);
      }
    } else if (id != null) {
      this.#write({ id, result: null });
    }
  }

  #close(reason: Error): void {
    if (this.#isClosed) {
      return;
    }
    this.#isClosed = true;
    this.#process.kill();
    const waiters = this.#waiters.values().toArray();
    this.#waiters.clear();
    for (const { reject } of waiters) {
      reject(reason);
    }
  }
}

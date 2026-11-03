// DjlintServer against a stand-in for `djlint --lsp` that answers as a test
// tells it to: the messages, failures and timing a real djLint gives no way to
// bring about on demand.
import { PassThrough } from "node:stream";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import {
  formattingOptions,
  liveToken,
  makeChannel,
  makeDocument,
} from "../../__tests__/helpers.js";
import { control, resetVscode } from "../../__tests__/vscode-stub.js";
import { DjlintServer, ServerResponseError } from "../subprocess/server.js";
import { RUN_TIMEOUT_MS } from "../types.js";

vi.mock("execa", () => ({ execa: vi.fn<typeof import("execa").execa>() }));

const VERSION = "1.49.0";
const HEADER_END = "\r\n\r\n";

interface Message {
  error?: { code: number; message: string };
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
}

type Handler = (message: Message) => void;

function frame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER_END}`), body]);
}

/** The process DjlintServer spawns: what it was sent, and how it answers. */
class FakeLanguageServer {
  readonly received: Message[] = [];
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  readonly handlers = new Map<string, Handler>([
    ["initialize", (request) => this.reply(request, { serverInfo: { version: VERSION } })],
    ["shutdown", (request) => this.reply(request, null)],
    ["exit", () => this.end()],
    ["textDocument/diagnostic", (request) => this.reply(request, { items: [] })],
    ["textDocument/formatting", (request) => this.reply(request, [])],
  ]);
  isKilled = false;
  readonly #exit = Promise.withResolvers<object>();

  constructor() {
    this.stdin.on("data", (chunk: Buffer) => {
      // DjlintServer writes each message whole, in one write.
      const text = chunk.toString("utf8");
      const body = text.slice(text.indexOf(HEADER_END) + HEADER_END.length);
      const message = JSON.parse(body) as Message;
      this.received.push(message);
      setImmediate(() => {
        this.handlers.get(message.method ?? "")?.(message);
      });
    });
  }

  get process(): Promise<object> {
    return Object.assign(this.#exit.promise, {
      kill: () => {
        this.isKilled = true;
        this.end();
      },
      stderr: this.stderr,
      stdin: this.stdin,
      stdout: this.stdout,
    });
  }

  get ended(): Promise<object> {
    return this.#exit.promise;
  }

  methods(): (string | undefined)[] {
    return this.received.map(({ method }) => method);
  }

  send(message: object): void {
    this.stdout.write(frame(message));
  }

  /**
   * Writes `data` a piece at a time, each piece in a later turn of the event loop.
   * @param data - What to write.
   * @param cuts - The offsets in `data` at which a piece ends and the next starts.
   */
  sendInPieces(data: Buffer, cuts: readonly number[]): void {
    const [cut, ...rest] = cuts;
    this.stdout.write(data.subarray(0, cut));
    if (cut != null) {
      setImmediate(() => {
        this.sendInPieces(
          data.subarray(cut),
          rest.map((offset) => offset - cut),
        );
      });
    }
  }

  reply(request: Message, result: unknown): void {
    this.send({ id: request.id, result });
  }

  end(): void {
    this.#exit.resolve({});
  }
}

const RANGE = { end: { character: 5, line: 1 }, start: { character: 2, line: 0 } };

describe(DjlintServer, () => {
  let channel: ReturnType<typeof makeChannel>;
  let server: DjlintServer;
  let fake: FakeLanguageServer;

  async function lint(token = liveToken()): Promise<unknown> {
    return server.lint(makeDocument("/w/t.html", "<p>x</p>"), {}, token);
  }

  /**
   * Has the stand-in answer each lint with `handler`.
   * @param handler - Gets the `textDocument/diagnostic` request.
   */
  function onLint(handler: Handler): void {
    fake.handlers.set("textDocument/diagnostic", handler);
  }

  beforeEach(() => {
    resetVscode();
    fake = new FakeLanguageServer();
    vi.mocked(execa).mockReturnValue(fake.process as never);
    channel = makeChannel();
    server = new DjlintServer("djlint", [], "/w", VERSION, channel);
  });

  afterEach(() => {
    server.dispose();
  });

  it("applies the edits it gets, each at the place it names in the text sent", async () => {
    fake.handlers.set("textDocument/formatting", (request) => {
      fake.reply(request, [
        {
          newText: "<div>",
          range: { end: { character: 4, line: 0 }, start: { character: 0, line: 0 } },
        },
        {
          newText: "</div>",
          range: { end: { character: 5, line: 1 }, start: { character: 0, line: 1 } },
        },
      ]);
    });
    await expect(
      server.format(makeDocument("/w/t.html", "<ul>\n</ul>"), {}, formattingOptions, liveToken()),
    ).resolves.toBe("<div>\n</div>");
  });

  it("leaves the text as it is without edits", async () => {
    fake.handlers.set("textDocument/formatting", (request) => {
      fake.reply(request, null);
    });
    await expect(
      server.format(makeDocument("/w/t.html", "<p>x</p>"), {}, formattingOptions, liveToken()),
    ).resolves.toBe("<p>x</p>");
  });

  it("reads a finding without a code, and a report without findings", async () => {
    onLint((request) => {
      fake.reply(request, { items: [{ message: "m", range: RANGE }] });
    });
    await expect(lint()).resolves.toStrictEqual([
      { code: "", column: 2, endColumn: 5, endLine: 2, isUtf16: true, line: 1, message: "m" },
    ]);
    onLint((request) => {
      fake.reply(request, {});
    });
    await expect(lint()).resolves.toStrictEqual([]);
  });

  it("refuses a server that names no version", async () => {
    fake.handlers.set("initialize", (request) => {
      fake.reply(request, {});
    });
    await expect(lint()).rejects.toThrow(
      "the language server is djLint of unknown version, not 1.49.0",
    );
  });

  it("fails a run the server fails, and goes on with the next", async () => {
    onLint(({ id }) => {
      fake.send({ error: { code: -32_603, message: "boom" }, id });
    });
    const failed = lint();
    await expect(failed).rejects.toBeInstanceOf(ServerResponseError);
    await expect(failed).rejects.toThrow("boom");
    onLint((request) => {
      fake.reply(request, { items: [] });
    });
    await expect(lint()).resolves.toStrictEqual([]);
    expect(server.isClosed).toBe(false);
  });

  it("takes a request the server cancelled for a cancelled run", async () => {
    onLint(({ id }) => {
      fake.send({ error: { code: -32_800, message: "cancelled" }, id });
    });
    await expect(lint()).rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it("asks the server to cancel a run, and keeps it once it does", async () => {
    const asked = Promise.withResolvers<undefined>();
    onLint(() => {
      asked.resolve(void 0);
    });
    fake.handlers.set("$/cancelRequest", ({ params }) => {
      const { id } = params as { id: number };
      fake.send({ error: { code: -32_800, message: "cancelled" }, id });
    });
    const source = new vscode.CancellationTokenSource();
    const run = lint(source.token);
    await asked.promise;
    source.cancel();
    await expect(run).rejects.toBeInstanceOf(vscode.CancellationError);
    const lintId = fake.received.find(({ method }) => method === "textDocument/diagnostic")?.id;
    expect(fake.received).toContainEqual(
      expect.objectContaining({ method: "$/cancelRequest", params: { id: lintId } }),
    );
    expect(server.isClosed).toBe(false);
  });

  it("sends nothing for a run cancelled before its turn", async () => {
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    await expect(lint(source.token)).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(fake.methods()).not.toContain("textDocument/didOpen");
  });

  it("passes over an answer to a request it didn't make", async () => {
    onLint((request) => {
      fake.send({ id: 999, result: { items: [{ message: "stray", range: RANGE }] } });
      fake.reply(request, { items: [] });
    });
    await expect(lint()).resolves.toStrictEqual([]);
  });

  it("logs what the server logs, at its level", async () => {
    onLint((request) => {
      fake.stderr.write("Traceback\n");
      for (const [type, message] of [
        [1, "an error"],
        [2, "a warning"],
        [3, "some info"],
        [4, "a log line"],
      ] as const) {
        fake.send({ method: "window/logMessage", params: { message, type } });
      }
      setImmediate(() => {
        fake.reply(request, { items: [] });
      });
    });
    await lint();
    expect(channel.of("error")).toStrictEqual(["an error"]);
    expect(channel.of("warn")).toStrictEqual(["a warning"]);
    expect(channel.of("info")).toStrictEqual(["some info", "a log line"]);
    expect(channel.of("debug")).toStrictEqual(["Traceback"]);
  });

  it("shows each message from the server once", async () => {
    onLint((request) => {
      for (const message of ["bad config", "bad config", "other"]) {
        fake.send({ method: "window/showMessage", params: { message, type: 1 } });
      }
      fake.reply(request, { items: [] });
    });
    await lint();
    await lint();
    expect(control.shownErrors).toStrictEqual(["bad config", "other"]);
  });

  it("answers a request from the server with nothing, and a notification not at all", async () => {
    onLint((request) => {
      fake.send({ id: "ask", method: "workspace/configuration", params: { items: [] } });
      fake.send({ method: "$/progress", params: {} });
      fake.reply(request, { items: [] });
    });
    await lint();
    expect(fake.received.filter(({ method }) => method == null)).toStrictEqual([
      { id: "ask", jsonrpc: "2.0", result: null },
    ]);
  });

  it("reads messages however the output is cut", async () => {
    onLint((request) => {
      const log = frame({ method: "window/logMessage", params: { message: "first", type: 3 } });
      const answer = frame({
        id: request.id,
        result: { items: [{ code: "H025", message: "😀", range: RANGE }] },
      });
      // Within the header of the answer, then two bytes into the emoji.
      fake.sendInPieces(Buffer.concat([log, answer]), [
        log.length + 5,
        log.length + answer.indexOf("😀") + 2,
      ]);
    });
    await expect(lint()).resolves.toMatchObject([{ code: "H025", message: "😀" }]);
    expect(channel.of("info")).toStrictEqual(["first"]);
  });

  it.each([
    ["without a length", "Content-Type: text/plain\r\n\r\n{}"],
    ["that isn't JSON", "Content-Length: 1\r\n\r\n{"],
  ])("ends on a message %s", async (_label, raw) => {
    onLint(() => {
      fake.stdout.write(raw);
    });
    await expect(lint()).rejects.toThrow("djLint's language server sent a bad message");
    expect(server.isClosed).toBe(true);
    expect(fake.isKilled).toBe(true);
  });

  it("fails the run it was on when it ends, and every run after", async () => {
    onLint(() => {
      fake.end();
    });
    await expect(lint()).rejects.toThrow("djLint's language server ended");
    expect(server.isClosed).toBe(true);
    await expect(lint()).rejects.toThrow("djLint's language server has ended");
  });

  it("ends when it can't write to the server", async () => {
    onLint(() => {
      fake.stdin.emit("error", new Error("EPIPE"));
    });
    await expect(lint()).rejects.toThrow("djLint's language server closed its input");
    expect(fake.isKilled).toBe(true);
  });

  it("ends a server that doesn't answer in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const asked = Promise.withResolvers<undefined>();
      onLint(() => {
        asked.resolve(void 0);
      });
      const run = lint();
      await asked.promise;
      vi.advanceTimersByTime(RUN_TIMEOUT_MS);
      await expect(run).rejects.toThrow(
        "djLint's language server timed out on textDocument/diagnostic",
      );
      expect(fake.isKilled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the server to shut down and then to exit", async () => {
    await lint();
    server.dispose();
    await fake.ended;
    expect(fake.methods().slice(-2)).toStrictEqual(["shutdown", "exit"]);
  });
});

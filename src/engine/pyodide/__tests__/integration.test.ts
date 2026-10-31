// The real worker and the real bundled djLint: what a mocked worker cannot
// prove, namely that djLint's Config accepts what the extension sends and that
// the runtime can reach the project's files. Skipped until both are built
// (`npm run assets && npm run -s esbuild-worker`).
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as vscode from "vscode";
import { everySetting } from "../../../__tests__/every-setting.js";
import {
  flush,
  formattingOptions,
  liveToken,
  makeChannel,
  makeConfig,
  makeContext,
  makeDocument,
  makePythonEnvironments,
  makeStatus,
  setWorkspaceFolders,
} from "../../../__tests__/helpers.js";
import {
  control,
  resetVscode,
  type TextEditRecord,
} from "../../../__tests__/vscode-stub.js";
import {
  formattingArgs,
  lintingArgs,
  type ArgContext,
  type CliArg,
} from "../../../args.js";
import { Formatter } from "../../../formatter.js";
import { Linter } from "../../../linter.js";
import { createDesktopEngine } from "../../desktop.js";
import { getDocumentFolder } from "../../document-folder.js";
import { EngineManager } from "../../select.js";
import { PyodideEngine } from "../index.js";
import { createNodeWorker } from "../node-worker.js";
import type { RunRequest, WorkerRequest, WorkerResponse } from "../protocol.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const workerPath = path.join(repoRoot, "dist", "pyodide-worker.cjs");
const indexURL = path.join(repoRoot, "assets", "pyodide");
const isBuilt =
  existsSync(workerPath) && existsSync(path.join(indexURL, "pyodide.mjs"));

const TIMEOUT_MS = 120_000;

const UGLY = `<div><p>hi</p>\n<img src="x.png">\n</div>`;
// H013: <img> without alt. One reliable violation.
const DIRTY = `<div><img src="x.png"></div>`;
const CLEAN = `<div>\n    <img src="x.png"\n         alt="x" />\n</div>\n`;
const BIG = `<div>${"<p>x</p>".repeat(3000)}</div>`;
// Too much to finish within a test, for a worker the test will terminate.
const ENDLESS = `<div>${"<p>x</p>".repeat(20_000)}</div>`;

const DOCUMENT_PATH = "/w/t.html";

function makeEngine(
  canReadProjectFiles = true,
  channel = makeChannel(),
): PyodideEngine {
  return new PyodideEngine(
    () => createNodeWorker(workerPath, indexURL),
    channel,
    canReadProjectFiles,
    makeStatus(),
    getDocumentFolder,
  );
}

async function settle(pending: Promise<unknown>): Promise<string> {
  return Promise.race([
    pending.then(
      () => "resolved",
      (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
    ),
    new Promise<string>((resolve) => {
      setTimeout(resolve, 60_000, "never settled");
    }),
  ]);
}

/** The names `args` send for these settings. */
function sentNames(
  args: readonly CliArg[],
  context: ArgContext,
): readonly string[] {
  return args.flatMap((arg) => arg.buildKwarg(context)?.[0] ?? []);
}

describe.skipIf(!isBuilt)("the bundled djLint", { timeout: TIMEOUT_MS }, () => {
  let channel: ReturnType<typeof makeChannel>;
  let engine: PyodideEngine;

  beforeAll(() => {
    channel = makeChannel();
    engine = makeEngine(true, channel);
  });

  afterAll(() => {
    engine.dispose();
  });

  beforeEach(() => {
    resetVscode();
    channel.lines.length = 0;
  });

  async function format(
    text: string,
    values: Readonly<Record<string, unknown>> = {},
    document = makeDocument(DOCUMENT_PATH, text),
  ): Promise<string> {
    return engine.format(
      document,
      makeConfig(values),
      formattingOptions,
      liveToken(),
    );
  }

  async function lintCodes(
    text: string,
    values: Readonly<Record<string, unknown>> = {},
    document = makeDocument(DOCUMENT_PATH, text),
  ): Promise<string[]> {
    const diagnostics = await engine.lint(
      document,
      makeConfig(values),
      liveToken(),
    );
    return diagnostics.map(({ code }) => code);
  }

  it("formats", async () => {
    await expect(format("<div><p>hi</p></div>")).resolves.toBe(
      "<div>\n    <p>hi</p>\n</div>\n",
    );
  });

  it("lints, with usable positions", async () => {
    const diagnostics = await engine.lint(
      makeDocument(DOCUMENT_PATH, `\n${DIRTY}`),
      makeConfig(),
      liveToken(),
    );
    expect(diagnostics).toMatchObject([{ code: "H013", column: 5, line: 2 }]);
    expect(diagnostics[0]?.message).toContain("alt");
  });

  it("finds nothing wrong with a clean document", async () => {
    await expect(lintCodes(CLEAN)).resolves.toStrictEqual([]);
  });

  it("logs the djLint it booted", async () => {
    const bootLog = makeChannel();
    const fresh = makeEngine(true, bootLog);
    try {
      await fresh.format(
        makeDocument(DOCUMENT_PATH, "<p>x</p>"),
        makeConfig(),
        formattingOptions,
        liveToken(),
      );
      expect(bootLog.of("info").join()).toContain("bundled djLint");
    } finally {
      fresh.dispose();
    }
  });

  it("accepts every format setting at once", async () => {
    const values = everySetting(formattingArgs);
    const context: ArgContext = {
      config: makeConfig(values),
      document: makeDocument(DOCUMENT_PATH),
      formattingOptions,
    };
    const named = formattingArgs.filter(({ vscodeName }) => vscodeName);
    expect(sentNames(formattingArgs, context)).toHaveLength(
      named.filter(({ isPath }) => !isPath).length,
    );

    await expect(
      format(
        `<div x-data="{a: 1}"><style>p{color:red}</style><script>let a=1</script><img src="x.png"></div>`,
        values,
      ),
    ).resolves.toContain("<img");
    expect(control.shownErrors).toStrictEqual([]);
  });

  it("accepts every lint setting at once", async () => {
    const values = everySetting(lintingArgs);
    const context: ArgContext = {
      config: makeConfig(values),
      document: makeDocument(DOCUMENT_PATH),
    };
    const named = lintingArgs.filter(({ vscodeName }) => vscodeName);
    expect(sentNames(lintingArgs, context)).toHaveLength(
      named.filter(({ isPath }) => !isPath).length,
    );

    await expect(lintCodes(DIRTY, values)).resolves.toBeInstanceOf(Array);
    expect(control.shownErrors).toStrictEqual([]);
  });

  describe("requirePragma", () => {
    const settings = { requirePragma: true };

    it("leaves a document without the pragma alone", async () => {
      await expect(format(UGLY, settings)).resolves.toBe(UGLY);
      await expect(lintCodes(DIRTY, settings)).resolves.toStrictEqual([]);
    });

    it("handles a document with the pragma", async () => {
      const pragma = "{# djlint:on #}\n";
      await expect(
        format(`${pragma}<div><p>hi</p></div>`, settings),
      ).resolves.toBe(`${pragma}<div>\n    <p>hi</p>\n</div>\n`);
      await expect(lintCodes(`${pragma}${DIRTY}`, settings)).resolves.toContain(
        "H013",
      );
    });
  });

  describe("settings", () => {
    it("take effect", async () => {
      await expect(
        format("<div><p>hi</p></div>", { useEditorIndentation: true }),
      ).resolves.toBe("<div>\n  <p>hi</p>\n</div>\n");
      await expect(
        lintCodes(DIRTY, { ignore: ["H013"] }),
      ).resolves.not.toContain("H013");
    });
  });

  describe("a djLint failure", () => {
    const invalid = { formatAttributeJsJsonPattern: "(" };

    it("shows the last line, logs the traceback, and notifies once", async () => {
      await expect(format("<p>x</p>", invalid)).rejects.toThrow("Traceback");
      await expect(format("<p>x</p>", invalid)).rejects.toThrow("Traceback");
      expect(control.shownErrors).toHaveLength(1);
      expect(control.shownErrors[0]).toMatch(/^Bundled djLint failed: /u);
      expect(control.shownErrors[0]).not.toContain("\n");
      expect(channel.of("error").join()).toContain("Traceback");

      await expect(format("<p>x</p>")).resolves.toContain("<p>");
    });
  });

  describe("project files", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "djlint-integration-"));
      setWorkspaceFolders(root);
    });

    afterEach(async () => {
      await rm(root, { force: true, recursive: true });
    });

    async function write(relative: string, content: string): Promise<void> {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }

    function documentIn(relative: string, text: string): vscode.TextDocument {
      return makeDocument(vscode.Uri.file(path.join(root, relative)), text);
    }

    const NESTED = "<div><p>hi</p></div>";
    const indented = (width: number): string =>
      `<div>\n${" ".repeat(width)}<p>hi</p>\n</div>\n`;

    it("reads pyproject.toml beside the document", async () => {
      await write("pyproject.toml", "[tool.djlint]\nindent = 7\n");
      await expect(
        format(NESTED, {}, documentIn("t.html", NESTED)),
      ).resolves.toBe(indented(7));
    });

    it("reads pyproject.toml from a folder above the document", async () => {
      await write("pyproject.toml", '[tool.djlint]\nignore = "H013"\n');
      await write("templates/app/t.html", DIRTY);
      await expect(
        lintCodes(DIRTY, {}, documentIn("templates/app/t.html", DIRTY)),
      ).resolves.not.toContain("H013");
    });

    it("prefers the nearest project in a monorepo", async () => {
      await write("pyproject.toml", "[tool.djlint]\nindent = 7\n");
      await write("packages/a/pyproject.toml", "[tool.djlint]\nindent = 3\n");
      await expect(
        format(NESTED, {}, documentIn("packages/a/t.html", NESTED)),
      ).resolves.toBe(indented(3));
    });

    it("does not read the project without permission", async () => {
      await write("pyproject.toml", "[tool.djlint]\nindent = 7\n");
      const restricted = makeEngine(false);
      try {
        await expect(
          restricted.format(
            documentIn("t.html", NESTED),
            makeConfig(),
            formattingOptions,
            liveToken(),
          ),
        ).resolves.toBe(indented(4));
      } finally {
        restricted.dispose();
      }
    });

    it("reads a djlint.configuration path from the workspace root", async () => {
      await write("conf/djlint.json", '{ "indent": 5 }\n');
      await write("sub/t.html", NESTED);
      await expect(
        format(
          NESTED,
          { configuration: "conf/djlint.json" },
          documentIn("sub/t.html", NESTED),
        ),
      ).resolves.toBe(indented(5));
    });

    it("reads an absolute djlint.configuration path", async () => {
      await write("conf/djlint.toml", "indent = 6\n");
      await expect(
        format(
          NESTED,
          { configuration: path.join(root, "conf", "djlint.toml") },
          documentIn("t.html", NESTED),
        ),
      ).resolves.toBe(indented(6));
    });

    it("reads a djlint.rules path", async () => {
      await write(
        "conf/rules.yaml",
        "- rule:\n    name: H999\n    message: no marquee\n    flags: re.I\n    patterns:\n      - <marquee\n",
      );
      await expect(
        lintCodes(
          "<marquee>x</marquee>",
          { rules: "conf/rules.yaml" },
          documentIn("t.html", "<marquee>x</marquee>"),
        ),
      ).resolves.toContain("H999");
    });

    it("imports a rule's python_module from the project", async () => {
      await write(
        "custom_rules/rule.py",
        [
          "def run(rule, config, html, filepath, line_ends):",
          '    return [{"code": rule["name"], "line": "1:0", "match": "x", "message": "custom"}]',
          "",
        ].join("\n"),
      );
      await write(
        "conf/module-rules.yaml",
        "- rule:\n    name: H998\n    message: custom\n    python_module: custom_rules.rule\n",
      );
      await expect(
        lintCodes(
          "<p>x</p>",
          { rules: "conf/module-rules.yaml" },
          documentIn("t.html", "<p>x</p>"),
        ),
      ).resolves.toContain("H998");
    });

    it("reads a virtual document's configuration through VS Code", async () => {
      const uri = vscode.Uri.parse("memfs://repo/app/templates/t.html");
      control.workspaceFolders = [
        { uri: vscode.Uri.parse("memfs://repo/app") as never },
      ];
      control.files = new Map([
        ["memfs://repo/app/pyproject.toml", "[tool.djlint]\nindent = 5\n"],
      ]);
      await expect(format(NESTED, {}, makeDocument(uri, NESTED))).resolves.toBe(
        indented(5),
      );
    });

    it("imports a rule's python_module afresh on every run, leaving no cache behind", async () => {
      const rule = (code: string): string =>
        [
          "def run(rule, config, html, filepath, line_ends):",
          `    return [{"code": "${code}", "line": "1:0", "match": "x", "message": "x"}]`,
          "",
        ].join("\n");
      await write("fresh_rules/rule.py", rule("H991"));
      await write(
        "conf/fresh-rules.yaml",
        "- rule:\n    name: H990\n    message: custom\n    python_module: fresh_rules.rule\n",
      );
      const lint = async (): Promise<string[]> =>
        lintCodes(
          "<p>x</p>",
          { rules: "conf/fresh-rules.yaml" },
          documentIn("t.html", "<p>x</p>"),
        );
      await expect(lint()).resolves.toContain("H991");
      await write("fresh_rules/rule.py", rule("H992"));
      await expect(lint()).resolves.toContain("H992");
      expect(existsSync(path.join(root, "fresh_rules/__pycache__"))).toBe(
        false,
      );
    });

    it("still works when the document's folder is gone", async () => {
      await expect(
        format(NESTED, {}, documentIn("deleted/t.html", NESTED)),
      ).resolves.toBe(indented(4));
    });
  });

  describe("the end of a request", () => {
    it("settles a request in flight on dispose", async () => {
      const doomed = makeEngine();
      const pending = doomed.format(
        makeDocument(DOCUMENT_PATH, ENDLESS),
        makeConfig(),
        formattingOptions,
        liveToken(),
      );
      setTimeout(() => {
        doomed.dispose();
      }, 200);
      await expect(settle(pending)).resolves.toBe(
        "rejected: djLint engine disposed",
      );
    });

    it("refuses new work once disposed", async () => {
      const doomed = makeEngine();
      doomed.dispose();
      await expect(
        settle(
          doomed.lint(
            makeDocument(DOCUMENT_PATH, "<p>x</p>"),
            makeConfig(),
            liveToken(),
          ),
        ),
      ).resolves.toMatch(/^rejected:/u);
    });

    it("settles on cancel, and the engine stays usable", async () => {
      const source = new vscode.CancellationTokenSource();
      const pending = engine.format(
        makeDocument(DOCUMENT_PATH, BIG),
        makeConfig(),
        formattingOptions,
        source.token,
      );
      setTimeout(() => {
        source.cancel();
      }, 200);
      await expect(settle(pending)).resolves.toMatch(/^rejected:/u);
      await expect(format("<div><p>hi</p></div>")).resolves.toContain(
        "<p>hi</p>",
      );
    });

    it("cancels a request still queued behind another", async () => {
      const source = new vscode.CancellationTokenSource();
      const running = format(BIG);
      const queued = engine.format(
        makeDocument(DOCUMENT_PATH, BIG),
        makeConfig(),
        formattingOptions,
        source.token,
      );
      source.cancel();
      await expect(queued).rejects.toBeInstanceOf(vscode.CancellationError);
      await expect(running).resolves.toContain("<p>");
    });

    it("never runs a request cancelled in the worker's queue", async () => {
      const worker = new Worker(workerPath, { workerData: { indexURL } });
      try {
        const answered: number[] = [];
        const done = Promise.withResolvers<undefined>();
        worker.on("message", (response: WorkerResponse) => {
          if (response.type === "result") {
            if (response.ok) {
              answered.push(response.id);
            }
            if (response.id === 3) {
              done.resolve(void 0);
            }
          }
        });
        const run = (id: number): RunRequest => ({
          cwd: void 0,
          filename: "t.html",
          id,
          mode: "format",
          options: {},
          pathOptions: {},
          project: void 0,
          src: "<p>x</p>",
          type: "run",
        });
        worker.postMessage(run(1));
        worker.postMessage(run(2));
        worker.postMessage({ id: 2, type: "cancel" } satisfies WorkerRequest);
        worker.postMessage(run(3));
        await done.promise;
        expect(answered).toStrictEqual([1, 3]);
      } finally {
        await worker.terminate();
      }
    });
  });

  // The same paths as formatter.test.ts and linter.test.ts, end to end. An
  // untrusted workspace pins the bundled runtime, so results don't depend on
  // this machine's PATH.
  describe("through the extension", () => {
    let engines: EngineManager;
    const uiChannel = makeChannel();

    function repositoryContext(): vscode.ExtensionContext {
      return makeContext(repoRoot);
    }

    beforeEach(() => {
      control.isTrusted = false;
      engines = new EngineManager(() =>
        createDesktopEngine(
          repositoryContext().extensionUri,
          uiChannel,
          makePythonEnvironments().environments,
          makeStatus(),
        ),
      );
    });

    afterEach(() => {
      engines.dispose();
    });

    it("formats through Formatter", async () => {
      const formatter = new Formatter(repositoryContext(), engines);
      const document = makeDocument(DOCUMENT_PATH, UGLY);
      const edits = (await formatter.provideDocumentFormattingEdits(
        document,
        formattingOptions,
        liveToken(),
      )) as unknown as [TextEditRecord];
      expect(edits).toHaveLength(1);
      expect(edits[0].newText).toContain('<img src="x.png">');
      expect(edits[0].range.end.line).toBe(document.lineCount - 1);

      const source = new vscode.CancellationTokenSource();
      const cancelled = formatter.provideDocumentFormattingEdits(
        document,
        formattingOptions,
        source.token,
      );
      source.cancel();
      await expect(cancelled).resolves.toBeUndefined();

      const superseded = formatter.provideDocumentFormattingEdits(
        document,
        formattingOptions,
        liveToken(),
      );
      const newest = formatter.provideDocumentFormattingEdits(
        document,
        formattingOptions,
        liveToken(),
      );
      await expect(superseded).resolves.toBeUndefined();
      await expect(newest).resolves.toHaveLength(1);
      formatter.dispose();
    });

    it("publishes through Linter", async () => {
      control.configuration = { enableLinting: true };
      const document = makeDocument(DOCUMENT_PATH, DIRTY);
      control.documents = [document];
      const linter = new Linter(repositoryContext(), uiChannel, engines);
      linter.activate();
      await expect
        .poll(() => control.diagnostics.has(document.uri.toString()), {
          timeout: TIMEOUT_MS,
        })
        .toBe(true);
      await flush();

      const [diagnostic] = control.diagnostics.get(
        document.uri.toString(),
      ) as readonly vscode.Diagnostic[] as [vscode.Diagnostic];
      expect(diagnostic.range.start.line).toBe(0);
      expect(diagnostic.code).toMatchObject({ value: "H013" });
      expect(diagnostic.severity).toBe(vscode.DiagnosticSeverity.Error);
      linter.dispose();
    });
  });
});

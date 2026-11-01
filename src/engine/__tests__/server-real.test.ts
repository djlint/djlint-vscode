// DjlintServer against a real `djlint --lsp`. Skipped where the djLint on PATH is too old to have one.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  formattingOptions,
  liveToken,
  makeChannel,
  makeDocument,
  setWorkspaceFolders,
} from "../../__tests__/helpers.js";
import { resetVscode } from "../../__tests__/vscode-stub.js";
import { DjlintServer, IDLE_STOP_MS } from "../subprocess/server.js";
import { isVersionAtLeast, parseDjlintVersion } from "../subprocess/version.js";

const { failed, stdout } = await execa("djlint", ["--version"], { reject: false });
const version = failed ? null : parseDjlintVersion(String(stdout));
const hasServer = version != null && isVersionAtLeast(version, "1.49");

describe("a language server that doesn't start", () => {
  it("lets go of a cancelled run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "djlint silent "));
    const script = path.join(root, "silent.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n");
    const server = new DjlintServer(process.execPath, [script], root, "1.49.0", makeChannel());
    try {
      const source = new vscode.CancellationTokenSource();
      const run = server.lint(
        makeDocument(vscode.Uri.file(path.join(root, "t.html")), "<p>x</p>"),
        {},
        source.token,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      source.cancel();
      await expect(run).rejects.toBeInstanceOf(vscode.CancellationError);
    } finally {
      server.dispose();
      await rm(root, { force: true, maxRetries: 30, recursive: true, retryDelay: 200 });
    }
  });
});

describe.runIf(hasServer)("a real language server", { timeout: 60_000 }, () => {
  let root: string;
  let server: DjlintServer;

  function documentOf(text: string): vscode.TextDocument {
    return makeDocument(vscode.Uri.file(path.join(root, "t.html")), text);
  }

  beforeAll(async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    root = await mkdtemp(path.join(os.tmpdir(), "djlint server "));
    await writeFile(path.join(root, "pyproject.toml"), "");
  });

  beforeEach(() => {
    resetVscode();
    setWorkspaceFolders(root);
    server = new DjlintServer("djlint", [], root, version ?? "", makeChannel());
  });

  afterEach(() => {
    server.dispose();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { force: true, maxRetries: 20, recursive: true });
  });

  it("formats", async () => {
    await expect(
      server.format(documentOf(`<div><img src="x.png"></div>`), {}, formattingOptions, liveToken()),
    ).resolves.toBe(`<div>\n    <img src="x.png">\n</div>\n`);
  });

  it("leaves formatted text as it is", async () => {
    const text = `<div>\n    <p>x</p>\n</div>\n`;
    await expect(server.format(documentOf(text), {}, formattingOptions, liveToken())).resolves.toBe(
      text,
    );
  });

  it("honors the settings of a run", async () => {
    await expect(
      server.format(
        documentOf(`<div><p>x</p></div>`),
        { indent: 2 },
        formattingOptions,
        liveToken(),
      ),
    ).resolves.toBe(`<div>\n  <p>x</p>\n</div>\n`);
  });

  it("takes no profile from the language of a document", async () => {
    const text = `{% load static %}<a href="/x">x</a>`;
    const asHtml = await server.lint(documentOf(text), {}, liveToken());
    const asDjango = await server.lint(
      Object.assign(documentOf(text), { languageId: "django-html" }),
      {},
      liveToken(),
    );
    expect(asDjango).toStrictEqual(asHtml);
  });

  it("imports a custom rule anew for each run", async () => {
    const project = path.join(root, "rules");
    await mkdir(project);
    await writeFile(path.join(project, "pyproject.toml"), "");
    await writeFile(
      path.join(project, ".djlint_rules.yaml"),
      "- rule:\n    name: C901\n    message: x\n    python_module: my_rule\n",
    );
    const module = path.join(project, "my_rule.py");
    const rule = (code: string): string =>
      `def run(rule, config, html, filepath, line_ends, *args, **kwargs):\n    return [{"code": "${code}", "line": "1:0", "match": "x", "message": "x"}]\n`;
    const document = makeDocument(vscode.Uri.file(path.join(project, "t.html")), "<p>x</p>");

    await writeFile(module, rule("C901"));
    await expect(server.lint(document, {}, liveToken())).resolves.toMatchObject([{ code: "C901" }]);
    await writeFile(module, rule("C9020"));
    await expect(server.lint(document, {}, liveToken())).resolves.toMatchObject([
      { code: "C9020" },
    ]);
  });

  it("ends a run that a cancellation can't reach", async () => {
    const project = path.join(root, "stuck");
    await mkdir(project);
    await writeFile(path.join(project, "pyproject.toml"), "");
    await writeFile(
      path.join(project, ".djlint_rules.yaml"),
      "- rule:\n    name: C901\n    message: x\n    python_module: stuck_rule\n",
    );
    await writeFile(
      path.join(project, "stuck_rule.py"),
      [
        "import pathlib, time",
        "def run(**_):",
        '    pathlib.Path("started").touch()',
        "    time.sleep(60)",
        "    return []",
        "",
      ].join("\n"),
    );
    const source = new vscode.CancellationTokenSource();
    const run = server.lint(
      makeDocument(vscode.Uri.file(path.join(project, "t.html")), "<p>x</p>"),
      {},
      source.token,
    );
    await vi.waitFor(
      () => {
        expect(existsSync(path.join(root, "started"))).toBe(true);
      },
      { timeout: 30_000 },
    );
    const queued = server.lint(documentOf(`<p>x</p>`), {}, liveToken());
    source.cancel();
    await expect(run).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(server.isClosed).toBe(true);
    // The run behind it, which must not count against the server.
    await expect(queued).rejects.toThrow("stopping");
    expect(server.isStopping).toBe(true);
  });

  it("gives up an answer for a text that has changed since", async () => {
    const document = documentOf(`<div><p>x</p></div>`);
    const run = server.format(document, {}, formattingOptions, liveToken());
    Object.assign(document, { version: document.version + 1 });
    await expect(run).rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it("reports findings in the columns of the editor", async () => {
    await expect(
      server.lint(documentOf(`<p>😀</p><img src="x">`), {}, liveToken()),
    ).resolves.toMatchObject([
      { code: "H013", column: 9, endColumn: 22, endLine: 1, isUtf16: true, line: 1 },
    ]);
  });

  it("answers one document after another", async () => {
    const document = documentOf(`<img src="x">`);
    const [format, lint] = await Promise.all([
      server.format(document, {}, formattingOptions, liveToken()),
      server.lint(document, {}, liveToken()),
    ]);
    expect(format).toBe(`<img src="x">\n`);
    expect(lint).toHaveLength(1);
  });

  it("refuses to be another version than was detected", async () => {
    const other = new DjlintServer("djlint", [], root, "0.1", makeChannel());
    await expect(other.lint(documentOf(`<p>x</p>`), {}, liveToken())).rejects.toThrow("not 0.1");
    other.dispose();
  });

  it("stops after a while with nothing to do", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await server.lint(documentOf(`<p>x</p>`), {}, liveToken());
      expect(server.isClosed).toBe(false);
      vi.advanceTimersByTime(IDLE_STOP_MS);
      expect(server.isStopping).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses work once it is stopping", async () => {
    await server.lint(documentOf(`<p>x</p>`), {}, liveToken());
    server.dispose();
    await expect(server.lint(documentOf(`<p>x</p>`), {}, liveToken())).rejects.toThrow("stopping");
  });

  it("ends when disposed", async () => {
    await server.lint(documentOf(`<p>x</p>`), {}, liveToken());
    server.dispose();
    await vi.waitFor(() => {
      expect(server.isClosed).toBe(true);
    });
  });
});

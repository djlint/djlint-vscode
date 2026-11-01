// SubprocessEngine against whatever djLint is installed: that its command line
// takes every flag the extension sends, and that its findings, which exit 1,
// come back as findings. Skipped where none is installed, such as CI.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { execa } from "execa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { everySetting } from "../../__tests__/every-setting.js";
import {
  formattingOptions,
  liveToken,
  makeChannel,
  makeConfig,
  makeDocument,
  makePythonEnvironments,
  makeStatus,
  setWorkspaceFolders,
} from "../../__tests__/helpers.js";
import { control, resetVscode } from "../../__tests__/vscode-stub.js";
import { formattingArgs, lintingArgs } from "../../args.js";
import { SubprocessEngine } from "../subprocess/index.js";
import { DjlintUnavailableError } from "../types.js";

const installed = await execa("djlint", ["--version"], { reject: false });

const DIRTY = `<div><img src="x.png"></div>`;

describe.skipIf(installed.failed)("the installed djLint", { timeout: 60_000 }, () => {
  let root: string;
  let document: vscode.TextDocument;
  let engine: SubprocessEngine;

  beforeAll(async () => {
    // Where this is set, djLint prints GitHub annotations whatever output format it is told.
    vi.stubEnv("GITHUB_ACTIONS", "");
    root = await mkdtemp(path.join(os.tmpdir(), "djlint-subprocess-"));
    await writeFile(path.join(root, "t.html"), DIRTY);
  });

  beforeEach(() => {
    resetVscode();
    setWorkspaceFolders(root);
    document = makeDocument(vscode.Uri.file(path.join(root, "t.html")), DIRTY);
    engine = new SubprocessEngine(
      makeChannel(),
      makePythonEnvironments().environments,
      makeStatus(),
    );
  });

  afterEach(() => {
    engine.dispose();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { force: true, maxRetries: 5, recursive: true });
  });

  it("formats, with the document's final newline left to djLint", async () => {
    await expect(
      engine.format(document, makeConfig(), formattingOptions, liveToken()),
    ).resolves.toBe(`<div>\n    <img src="x.png">\n</div>\n`);
  });

  it("returns findings despite the exit code", async () => {
    await expect(engine.lint(document, makeConfig(), liveToken())).resolves.toMatchObject([
      { code: "H013", column: 5, line: 1 },
    ]);
    expect(control.shownErrors).toStrictEqual([]);
  });

  it("takes every format flag at once", async () => {
    await expect(
      engine.format(
        document,
        makeConfig(everySetting(formattingArgs)),
        formattingOptions,
        liveToken(),
      ),
    ).resolves.toContain("<img");
    expect(control.shownErrors).toStrictEqual([]);
  });

  it("takes every lint flag at once", async () => {
    await expect(
      engine.lint(document, makeConfig(everySetting(lintingArgs)), liveToken()),
    ).resolves.toBeInstanceOf(Array);
    expect(control.shownErrors).toStrictEqual([]);
  });
});

describe("a command that is not there", () => {
  const absolute = path.join(os.tmpdir(), "djlint no such folder");
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "djlint missing "));
    vi.stubEnv("PATH", root);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { force: true, recursive: true });
  });

  it.each([
    ["no-such-djlint", "no-such-python"],
    [path.join(absolute, "djlint"), path.join(absolute, "python")],
  ])("is passed over for what comes next: %s", async (executablePath, pythonPath) => {
    resetVscode();
    setWorkspaceFolders(root);
    const engine = new SubprocessEngine(
      makeChannel(),
      makePythonEnvironments().environments,
      makeStatus(),
    );
    await expect(
      engine.lint(
        makeDocument(vscode.Uri.file(path.join(root, "t.html"))),
        makeConfig({ executablePath, pythonPath }),
        liveToken(),
      ),
    ).rejects.toBeInstanceOf(DjlintUnavailableError);
    expect(control.shownErrors).toStrictEqual([]);
  });
});

describe.runIf(process.platform === "win32")("a Windows wrapper", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "djlint wrapper "));
    await writeFile(
      path.join(root, "djlint-wrapper.cmd"),
      "@echo off\r\necho djlint, version 1.48.0\r\n",
    );
    await writeFile(
      path.join(root, "wrapper.py"),
      "#!/usr/bin/env node\nconsole.log('djlint, version 1.48.0');\n",
    );
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it.each(["djlint-wrapper.cmd", "djlint-wrapper", "wrapper.py"])(
    "is found as %s",
    async (name) => {
      resetVscode();
      setWorkspaceFolders(root);
      const status = makeStatus();
      const engine = new SubprocessEngine(
        makeChannel(),
        makePythonEnvironments().environments,
        status,
      );
      await engine.lint(
        makeDocument(vscode.Uri.file(path.join(root, "t.html"))),
        makeConfig({ executablePath: path.join(root, name) }),
        liveToken(),
      );
      expect(status.update).toHaveBeenCalledOnce();
    },
  );
});

const SHIM = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "djlint, version $(cat .python-version)"
fi
`;

describe.skipIf(process.platform === "win32")("a version manager's shim", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "djlint-shim-"));
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "djlint"), SHIM);
    await chmod(path.join(root, "bin", "djlint"), 0o755);
    await Promise.all(
      ["1.30.0", "1.48.0"].map(async (version) => {
        await mkdir(path.join(root, version));
        await writeFile(path.join(root, version, ".python-version"), version);
      }),
    );
    vi.stubEnv("PATH", `${path.join(root, "bin")}${path.delimiter}${process.env["PATH"] ?? ""}`);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { force: true, recursive: true });
  });

  it("gets the version it picks in each folder", async () => {
    resetVscode();
    setWorkspaceFolders(root);
    const status = makeStatus();
    const engine = new SubprocessEngine(
      makeChannel(),
      makePythonEnvironments().environments,
      status,
    );
    for (const version of ["1.30.0", "1.48.0"]) {
      const document = makeDocument(vscode.Uri.file(path.join(root, version, "t.html")));
      // oxlint-disable-next-line no-await-in-loop -- the order is the point
      await engine.lint(document, makeConfig(), liveToken());
      expect(vi.mocked(status.update).mock.lastCall?.[1]).toBe(version);
    }
  });
});

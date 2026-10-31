// SubprocessEngine against whatever djLint is installed: that its command line
// takes every flag the extension sends, and that its findings, which exit 1,
// come back as findings. Skipped where none is installed, such as CI.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const installed = await execa("djlint", ["--version"], { reject: false });

const DIRTY = `<div><img src="x.png"></div>`;

describe.skipIf(installed.failed)(
  "the installed djLint",
  { timeout: 60_000 },
  () => {
    let root: string;
    let document: vscode.TextDocument;
    let engine: SubprocessEngine;

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "djlint-subprocess-"));
      await writeFile(path.join(root, "t.html"), DIRTY);
    });

    afterAll(async () => {
      await rm(root, { force: true, recursive: true });
    });

    beforeEach(() => {
      resetVscode();
      setWorkspaceFolders(root);
      document = makeDocument(
        vscode.Uri.file(path.join(root, "t.html")),
        DIRTY,
      );
      engine = new SubprocessEngine(
        makeChannel(),
        makePythonEnvironments().environments,
        makeStatus(),
      );
    });

    it("formats, with the document's final newline left to djLint", async () => {
      await expect(
        engine.format(document, makeConfig(), formattingOptions, liveToken()),
      ).resolves.toBe(`<div>\n    <img src="x.png">\n</div>\n`);
    });

    it("returns findings despite the exit code", async () => {
      await expect(
        engine.lint(document, makeConfig(), liveToken()),
      ).resolves.toMatchObject([{ code: "H013", column: 5, line: 1 }]);
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
        engine.lint(
          document,
          makeConfig(everySetting(lintingArgs)),
          liveToken(),
        ),
      ).resolves.toBeInstanceOf(Array);
      expect(control.shownErrors).toStrictEqual([]);
    });
  },
);

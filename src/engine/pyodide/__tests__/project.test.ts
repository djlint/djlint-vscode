// How a document with no folder to mount gets its configuration to the worker.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChannel, makeDocument } from "../../../__tests__/helpers.js";
import {
  control,
  resetVscode,
  Uri,
  workspace,
} from "../../../__tests__/vscode-stub.js";
import { readProject } from "../project.js";

const FOLDER = Uri.parse("memfs://repo/app");

function document(relativePath: string): ReturnType<typeof makeDocument> {
  return makeDocument(
    Uri.joinPath(FOLDER, ...relativePath.split("/")) as never,
  );
}

let channel: ReturnType<typeof makeChannel>;

beforeEach(() => {
  resetVscode();
  channel = makeChannel();
  control.workspaceFolders = [{ uri: FOLDER }];
});

describe("readProject", () => {
  it("reads a path setting that leaves the folder, keeping it under the project", async () => {
    control.files = new Map([["memfs://repo/shared/rules.yaml", "rules"]]);
    const read = await readProject(
      document("a.html"),
      { rules: "a/../../shared/rules.yaml" },
      channel,
    );
    expect(read?.project.files).toStrictEqual({
      ".outside/rules/rules.yaml": "rules",
    });
    expect(read?.pathOptions).toStrictEqual({
      rules: "/project/.outside/rules/rules.yaml",
    });
  });

  it("drops a path setting it cannot read, with a warning", async () => {
    const read = await readProject(
      document("a.html"),
      { rules: "missing.yaml" },
      channel,
    );
    expect(read?.pathOptions).toStrictEqual({});
    expect(channel.of("warn").join()).toContain("missing.yaml");
  });

  it("treats a Windows path as absolute without a path module to help", async () => {
    const read = await readProject(
      document("a.html"),
      { rules: "D:\\shared\\rules.yaml" },
      channel,
    );
    expect(read?.pathOptions).toStrictEqual({});
  });

  it("has nothing to read outside a workspace folder", async () => {
    control.workspaceFolders = [];
    await expect(
      readProject(document("a.html"), {}, channel),
    ).resolves.toBeUndefined();
  });

  it("collects the configuration from the root down to the document", async () => {
    control.files = new Map([
      ["memfs://repo/app/pyproject.toml", "root"],
      ["memfs://repo/app/templates/djlint.toml", "nearest"],
      ["memfs://repo/app/other/djlint.toml", "unrelated"],
      ["memfs://repo/app/templates/page.html", "not configuration"],
    ]);
    const read = await readProject(
      document("templates/sub/a.html"),
      {},
      channel,
    );
    expect(read?.project).toStrictEqual({
      cwd: "templates/sub",
      files: { "pyproject.toml": "root", "templates/djlint.toml": "nearest" },
    });
  });

  it("reads no more than the configuration a folder lists", async () => {
    control.files = new Map([
      ["memfs://repo/app/.djlintrc", "root"],
      ["memfs://repo/app/templates/page.html", "not configuration"],
      ["memfs://repo/app/templates/pyproject.toml/not-a-file", "a folder"],
    ]);
    const readFile = vi.spyOn(workspace.fs, "readFile");
    const read = await readProject(document("templates/a.html"), {}, channel);
    expect(read?.project.files).toStrictEqual({ ".djlintrc": "root" });
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("runs from the root for a document at the root", async () => {
    const read = await readProject(document("a.html"), {}, channel);
    expect(read?.project).toStrictEqual({ cwd: ".", files: {} });
  });

  it("reads the file a path setting names, and points the setting at it", async () => {
    control.files = new Map([["memfs://repo/app/conf/rules.yaml", "rules"]]);
    const read = await readProject(
      document("a.html"),
      { rules: "conf/rules.yaml" },
      channel,
    );
    expect(read?.project.files).toStrictEqual({ "conf/rules.yaml": "rules" });
    expect(read?.pathOptions).toStrictEqual({
      rules: "/project/conf/rules.yaml",
    });
  });
});

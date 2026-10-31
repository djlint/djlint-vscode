// djLint discovers pyproject.toml/.djlintrc by walking up from its cwd, so cwd
// decides which config a file in a monorepo gets. These cover the two halves
// of that: configured `configuration`/`rules` paths resolve against the
// WORKSPACE root, while cwd stays beside the DOCUMENT so discovery finds the
// nearest config.
import { beforeEach, describe, expect, it } from "vitest";
import { configurationArg, rulesArg } from "../args.js";
import {
  normalizeConfiguredExecutable,
  resolveWorkspaceFilePath,
} from "../paths.js";
import {
  makeConfig,
  makeDocument,
  portable,
  setWorkspaceFolders,
} from "./helpers.js";
import { resetVscode } from "./vscode-stub.js";

const nested = makeDocument("/ws/packages/a/t.html");
const loose = makeDocument("/elsewhere/loose.html");

beforeEach(() => {
  resetVscode();
  setWorkspaceFolders("/ws");
});

describe("resolveWorkspaceFilePath", () => {
  it("resolves a bare filename to the workspace root, not the document", () => {
    expect(portable(resolveWorkspaceFilePath(".djlintrc", nested))).toBe(
      "/ws/.djlintrc",
    );
  });

  it("resolves a relative path to the workspace root", () => {
    expect(
      portable(resolveWorkspaceFilePath("config/djlint.toml", nested)),
    ).toBe("/ws/config/djlint.toml");
  });

  it("leaves an absolute path alone", () => {
    expect(portable(resolveWorkspaceFilePath("/etc/djlint.toml", nested))).toBe(
      "/etc/djlint.toml",
    );
  });

  it("does not guess without a workspace folder", () => {
    expect(resolveWorkspaceFilePath(".djlintrc", loose)).toBe(".djlintrc");
  });
});

describe("path arguments", () => {
  it("emit a path djLint need not interpret against its cwd", () => {
    expect(
      configurationArg
        .build({
          config: makeConfig({ configuration: ".djlintrc" }),
          document: nested,
        })
        .map((part) => portable(part)),
    ).toStrictEqual(["--configuration", "/ws/.djlintrc"]);
    expect(
      rulesArg
        .build({
          config: makeConfig({ rules: "rules.yaml" }),
          document: nested,
        })
        .map((part) => portable(part)),
    ).toStrictEqual(["--rules", "/ws/rules.yaml"]);
  });

  it("emit nothing when unset", () => {
    expect(
      configurationArg.build({
        config: makeConfig({ configuration: "" }),
        document: nested,
      }),
    ).toStrictEqual([]);
  });
});

// Configured EXECUTABLES follow a deliberately different rule, and the two
// policies live side by side, so pin what separates them: a bare name is a PATH
// lookup, where a bare config filename means the workspace's.
describe("normalizeConfiguredExecutable", () => {
  it.each(["djlint", "python3"])("keeps %s a PATH lookup", (name) => {
    expect(normalizeConfiguredExecutable(name, nested)).toBe(name);
  });

  it("differs from a bare config filename", () => {
    expect(portable(resolveWorkspaceFilePath("djlint", nested))).toBe(
      "/ws/djlint",
    );
  });

  it.each(["bin/djlint", "./bin/djlint"])(
    "resolves path-shaped %s to the workspace root",
    (value) => {
      expect(portable(normalizeConfiguredExecutable(value, nested))).toBe(
        "/ws/bin/djlint",
      );
    },
  );

  it("leaves an absolute path alone", () => {
    expect(
      portable(normalizeConfiguredExecutable("/usr/bin/djlint", nested)),
    ).toBe("/usr/bin/djlint");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeConfiguredExecutable("  djlint  ", nested)).toBe("djlint");
  });

  it.each(["   ", ""])("treats %j as unset", (value) => {
    expect(normalizeConfiguredExecutable(value, nested)).toBe("");
  });

  it("does not guess without a workspace folder", () => {
    expect(normalizeConfiguredExecutable("bin/djlint", loose)).toBe(
      "bin/djlint",
    );
  });
});

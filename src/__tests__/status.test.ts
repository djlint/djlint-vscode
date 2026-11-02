import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";

import { DjlintStatus, updateForLanguage } from "../status.js";
import { makeDocument, setWorkspaceFolders } from "./helpers.js";
import { control, fireWorkspaceEvent, resetVscode, setActiveDocument } from "./vscode-stub.js";

const document = makeDocument("/a/t.html");

function item(): (typeof control.statusItems)[number] {
  const [first] = control.statusItems;
  if (!first) {
    throw new Error("no status item");
  }
  return first;
}

function tooltip(): string {
  return item().tooltip?.value ?? "";
}

describe(DjlintStatus, () => {
  beforeEach(() => {
    resetVscode();
    control.configuration = { formatLanguages: ["html"] };
  });

  it("shows only for the languages djLint formats, and opens its menu", () => {
    const status = new DjlintStatus();
    expect(item().visible).toBe(false);
    setActiveDocument(document);
    expect(item().visible).toBe(true);
    expect(item().command).toBe("djlint.showMenu");
    setActiveDocument({ ...document, languageId: "python" });
    expect(item().visible).toBe(false);
    status.dispose();
  });

  it("follows a change of the file's language", () => {
    const status = new DjlintStatus();
    setActiveDocument(document);
    const python = { ...document, languageId: "python" };
    control.activeDocument = python;
    fireWorkspaceEvent("open", python);
    expect(item().visible).toBe(false);
    status.dispose();
  });

  it("names the djLint in use, and where it comes from", () => {
    const status = new DjlintStatus();
    setActiveDocument(document);
    status.update(document, "1.47.1", "/venv/bin/djlint");
    expect(item().text).toBe("djLint 1.47.1");
    expect(tooltip()).toContain(String.raw`/venv/bin/djlint`);
  });

  it("shows the djLint of the active document's folder", () => {
    setWorkspaceFolders("/a", "/b");
    const status = new DjlintStatus();
    const other = makeDocument("/b/t.html");
    status.update(document, "1.0", "first");
    status.update(other, "2.0", "second");

    setActiveDocument(document);
    expect(item().text).toBe("djLint 1.0");
    setActiveDocument(other);
    expect(item().text).toBe("djLint 2.0");
  });

  it("tells apart the projects of a workspace folder", () => {
    setWorkspaceFolders("/a");
    const status = new DjlintStatus();
    const one = makeDocument("/a/one/t.html");
    const two = makeDocument("/a/two/t.html");
    status.update(one, "1.0", "first");
    status.update(two, "2.0", "second");

    setActiveDocument(one);
    expect(item().text).toBe("djLint 1.0");
    setActiveDocument(two);
    expect(item().text).toBe("djLint 2.0");
  });

  it("shows what its folder uses for a file that has not run yet", () => {
    setWorkspaceFolders("/a");
    const status = new DjlintStatus();
    status.update(makeDocument("/a/one.html"), "1.0", "first");
    setActiveDocument(makeDocument("/a/two.html"));
    expect(item().text).toBe("djLint 1.0");
  });

  it("warns while the last run on the file failed", () => {
    const status = new DjlintStatus();
    setActiveDocument(document);
    status.update(document, "1.0", "first");
    status.ran(document, "lint", false);
    expect(item().text).toBe("$(warning) djLint 1.0");
    expect(item().accessibilityInformation?.label).toBe("djLint 1.0. Linting this file failed.");
    expect(item().backgroundColor).toBeInstanceOf(vscode.ThemeColor);
    expect(tooltip()).toContain("Linting this file failed.");
    status.ran(document, "lint", true);
    expect(item().text).toBe("djLint 1.0");
    expect(item().backgroundColor).toBeUndefined();
  });

  it("keeps a failed format in view while linting works", () => {
    const status = new DjlintStatus();
    setActiveDocument(document);
    status.ran(document, "format", false);
    status.ran(document, "lint", false);
    status.ran(document, "lint", true);
    expect(item().text).toBe("$(warning) djLint");
    expect(item().accessibilityInformation?.label).toBe("djLint. Formatting this file failed.");
    status.ran(document, "format", true);
    expect(item().text).toBe("djLint");
  });

  it("escapes what djLint's source says, icons included", () => {
    const status = new DjlintStatus();
    setActiveDocument(document);
    status.update(document, "1.0", "/$(gear)/[x](command:y)");
    expect(tooltip()).toContain(String.raw`/\$\(gear\)/\[x\]\(command:y\)`);
    status.dispose();
  });

  it("forgets a file once it is closed", () => {
    const status = new DjlintStatus();
    status.ran(document, "lint", false);
    fireWorkspaceEvent("close", document);
    setActiveDocument(document);
    expect(item().text).toBe("djLint");
  });

  it("forgets what it showed on a restart", () => {
    const status = new DjlintStatus();
    setActiveDocument(document);
    status.update(document, "1.47.1", "bundled");
    status.ran(document, "lint", false);
    status.clear();
    expect(item().text).toBe("djLint");
  });

  it("follows djlint.formatLanguages", () => {
    const status = new DjlintStatus();
    setActiveDocument(makeDocument("/a/t.jinja"));
    const jinja = { ...makeDocument("/a/t.jinja"), languageId: "jinja" };
    setActiveDocument(jinja);
    expect(item().visible).toBe(false);
    control.configuration = { formatLanguages: ["jinja"] };
    fireWorkspaceEvent("config", {
      affectsConfiguration: (section: string) => section === "djlint",
    });
    expect(item().visible).toBe(true);
    status.dispose();
  });

  it("offers what applies to the file", () => {
    const status = new DjlintStatus();
    setActiveDocument(document);
    expect(tooltip()).toContain("Not linting `html` · [Turn on](command:djlint.toggleLinting)");
    expect(tooltip()).toContain("[Use djLint](command:djlint.useAsFormatter)");
    expect(tooltip()).not.toContain("djlint.toggleLintOnType");

    control.configuration = {
      enableLinting: true,
      "editor.defaultFormatter": "monosans.djlint",
      formatLanguages: ["html"],
      lintOnType: true,
    };
    fireWorkspaceEvent("config", { affectsConfiguration: () => true });
    expect(tooltip()).toContain("Linting `html` · [Turn off](command:djlint.toggleLinting)");
    expect(tooltip()).toContain("[Turn off](command:djlint.toggleLintOnType)");
    expect(tooltip()).toContain("$(check) Formatting `html`");
    expect(tooltip()).not.toContain("djlint.useAsFormatter");
    expect(item().tooltip?.isTrusted).toMatchObject({
      enabledCommands: expect.arrayContaining(["djlint.toggleLinting", "djlint.showLogs"]),
    });
    status.dispose();
  });

  it("runs what is picked from its menu", async () => {
    const status = new DjlintStatus();
    setActiveDocument(document);
    const labels: string[] = [];
    control.quickPick = (items) => {
      labels.push(...items.map(({ label }) => label));
      return items.find(({ label }) => label.includes("Show Logs"));
    };
    await status.showMenu();
    expect(labels).toContain("$(circle-slash) Not linting html");
    expect(labels).not.toContain("$(check) Formatting html");
    expect(control.executedCommands).toStrictEqual([{ args: [], id: "djlint.showLogs" }]);
  });
});

describe(updateForLanguage, () => {
  beforeEach(() => {
    resetVscode();
  });

  it.each([
    [{}, vscode.ConfigurationTarget.Global],
    [{ workspaceValue: false }, vscode.ConfigurationTarget.Workspace],
    [{ workspaceLanguageValue: false }, vscode.ConfigurationTarget.Workspace],
    [{ workspaceFolderLanguageValue: false }, vscode.ConfigurationTarget.WorkspaceFolder],
  ])("writes for the language where %o would hide a user setting", async (inspected, target) => {
    control.inspected = { enableLinting: inspected };
    await updateForLanguage(document, "djlint", "enableLinting", true);
    expect(control.configurationUpdates).toStrictEqual([
      { key: "enableLinting", overrideInLanguage: true, scope: document, target, value: true },
    ]);
  });
});

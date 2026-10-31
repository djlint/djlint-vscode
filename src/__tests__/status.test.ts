import { beforeEach, describe, expect, it } from "vitest";
import { DjlintStatus } from "../status.js";
import { makeDocument, setWorkspaceFolders } from "./helpers.js";
import { control, resetVscode, setActiveDocument } from "./vscode-stub.js";

const document = makeDocument("/a/t.html");

beforeEach(() => {
  resetVscode();
  control.configuration = { formatLanguages: ["django-html"] };
});

describe("DjlintStatus", () => {
  it("appears for the languages djLint formats and opens the logs", () => {
    const status = new DjlintStatus();
    const [item] = control.statusItems;
    expect(item?.selector).toStrictEqual(["django-html"]);
    expect(item?.command).toMatchObject({ command: "djlint.showLogs" });
    status.dispose();
  });

  it("names the djLint in use", () => {
    const status = new DjlintStatus();
    setActiveDocument(document);
    status.update(document, "1.47.1", "bundled");
    const [item] = control.statusItems;
    expect(item?.text).toBe("djLint 1.47.1");
    expect(item?.detail).toBe("bundled");
  });

  it("shows the djLint of the active document's folder", () => {
    setWorkspaceFolders("/a", "/b");
    const status = new DjlintStatus();
    const other = makeDocument("/b/t.html");
    status.update(document, "1.0", "first");
    status.update(other, "2.0", "second");
    const [item] = control.statusItems;

    setActiveDocument(document);
    expect(item?.text).toBe("djLint 1.0");
    setActiveDocument(other);
    expect(item?.text).toBe("djLint 2.0");
  });

  it("tells apart the projects of a workspace folder", () => {
    setWorkspaceFolders("/a");
    const status = new DjlintStatus();
    const one = makeDocument("/a/one/t.html");
    const two = makeDocument("/a/two/t.html");
    status.update(one, "1.0", "first");
    status.update(two, "2.0", "second");
    const [item] = control.statusItems;

    setActiveDocument(one);
    expect(item?.text).toBe("djLint 1.0");
    setActiveDocument(two);
    expect(item?.text).toBe("djLint 2.0");
  });

  it("tells apart the files of a folder, which can differ by language", () => {
    setWorkspaceFolders("/a");
    const status = new DjlintStatus();
    const one = makeDocument("/a/one.html");
    const two = makeDocument("/a/two.jinja");
    status.update(one, "1.0", "first");
    status.update(two, "2.0", "second");
    const [item] = control.statusItems;

    setActiveDocument(one);
    expect(item?.text).toBe("djLint 1.0");
    setActiveDocument(two);
    expect(item?.text).toBe("djLint 2.0");
  });

  it("shows what its folder uses for a file that has not run yet", () => {
    setWorkspaceFolders("/a");
    const status = new DjlintStatus();
    status.update(makeDocument("/a/one.html"), "1.0", "first");
    setActiveDocument(makeDocument("/a/two.html"));
    expect(control.statusItems[0]?.text).toBe("djLint 1.0");
  });

  it("forgets what it showed on a restart", () => {
    const status = new DjlintStatus();
    status.update(document, "1.47.1", "bundled");
    status.clear();
    const [item] = control.statusItems;
    expect(item?.text).toBe("djLint");
    expect(item?.detail).toBe("");
  });

  it("follows djlint.formatLanguages", () => {
    const status = new DjlintStatus();
    control.configuration = { formatLanguages: ["jinja"] };
    status.refreshLanguages();
    expect(control.statusItems[0]?.selector).toStrictEqual(["jinja"]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { DjlintStatus } from "../status.js";
import { control, resetVscode } from "./vscode-stub.js";

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
    status.update("1.47.1", "bundled");
    const [item] = control.statusItems;
    expect(item?.text).toBe("djLint 1.47.1");
    expect(item?.detail).toBe("bundled");
  });

  it("follows djlint.formatLanguages", () => {
    const status = new DjlintStatus();
    control.configuration = { formatLanguages: ["jinja"] };
    status.refreshLanguages();
    expect(control.statusItems[0]?.selector).toStrictEqual(["jinja"]);
  });
});

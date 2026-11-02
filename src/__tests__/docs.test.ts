import { beforeEach, describe, expect, it } from "vitest";

import { docsUrl } from "../docs.js";
import { control, resetVscode } from "./vscode-stub.js";

describe(docsUrl, () => {
  beforeEach(() => {
    resetVscode();
  });

  it("links to the English docs in English", () => {
    expect(docsUrl("linter/#h013")).toBe("https://djlint.com/docs/linter/#h013");
  });

  it.each([
    ["ru", "https://djlint.com/ru/docs/linter/#h013"],
    ["zh-cn", "https://djlint.com/zh/docs/linter/#h013"],
    ["zh-tw", "https://djlint.com/zh-tw/docs/linter/#h013"],
    ["pt-br", "https://djlint.com/pt-br/docs/linter/#h013"],
  ])("links to the docs in the display language %s", (language, url) => {
    control.language = language;
    expect(docsUrl("linter/#h013")).toBe(url);
  });

  it("links to the English docs in a language the site has no translation for", () => {
    control.language = "hu";
    expect(docsUrl("getting-started/")).toBe("https://djlint.com/docs/getting-started/");
  });
});

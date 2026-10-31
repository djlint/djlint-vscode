// The language IDs are written out in three places that have to agree.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Manifest {
  contributes: {
    configuration: { properties: Record<string, { default?: unknown }> };
    configurationDefaults: Record<string, Record<string, unknown>>;
  };
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
const languages = manifest.contributes.configuration.properties[
  "djlint.formatLanguages"
]?.default as string[];

describe("the language IDs", () => {
  it("have no duplicates", () => {
    expect(new Set(languages).size).toBe(languages.length);
  });

  it("all have defaults that turn linting on", () => {
    const defaults = manifest.contributes.configurationDefaults;
    expect(Object.keys(defaults)).toStrictEqual(
      languages.map((language) => `[${language}]`),
    );
    for (const settings of Object.values(defaults)) {
      expect(settings["djlint.enableLinting"]).toBe(true);
    }
  });

  it("are all in the README's example", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain(
      languages.map((language) => `[${language}]`).join(""),
    );
  });
});

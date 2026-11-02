// Every translation has to cover the English strings exactly, and keep what is not prose.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const locales = [
  "cs",
  "de",
  "es",
  "fr",
  "it",
  "ja",
  "ko",
  "pl",
  "pt-br",
  "ru",
  "tr",
  "zh-cn",
  "zh-tw",
];

function readJson(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".ts") && !entry.parentPath.includes("__tests__"),
    )
    .map((entry) => `${entry.parentPath}/${entry.name}`);
}

// The parts a translation copies as they are: placeholders, code, setting links and URLs.
function kept(text: string): string[] {
  return [...text.matchAll(/\{\d+\}|`[^`]*`|#[\w.]+#|https?:\/\/[^\s)]+/gu)]
    .map(([part]) => part)
    .toSorted();
}

const sources = sourceFiles("src").map((file) => readFileSync(file, "utf8"));
const messages = new Set(
  sources.flatMap((source) =>
    [...source.matchAll(/l10n\.t\(\s*("(?:[^"\\]|\\.)*")/gu)].map(
      ([, literal]) => JSON.parse(literal ?? "") as string,
    ),
  ),
);

const manifest = readFileSync("package.json", "utf8");
const nlsKeys = new Set([...manifest.matchAll(/"%([^%"]+)%"/gu)].map(([, key]) => key));

describe.each([
  { english: readJson("l10n/bundle.l10n.json"), file: "l10n/bundle.l10n.{0}.json" },
  { english: readJson("package.nls.json"), file: "package.nls.{0}.json" },
])("$file", ({ english, file }) => {
  it.each(locales)("%s translates every string, keeping what is not prose", (locale) => {
    const translation = readJson(file.replace("{0}", locale));
    expect(Object.keys(translation).toSorted()).toStrictEqual(Object.keys(english).toSorted());
    for (const [key, text] of Object.entries(english)) {
      const translated = translation[key] ?? "";
      expect(translated.trim(), key).not.toBe("");
      expect(kept(translated), key).toStrictEqual(kept(text));
    }
  });
});

describe("the English strings", () => {
  it("are all literals, so they can be listed", () => {
    const calls = sources.reduce((sum, source) => sum + source.split("l10n.t(").length - 1, 0);
    expect(calls).toBeGreaterThan(0);
    expect(messages.size).toBeLessThanOrEqual(calls);
    expect(
      sources.reduce((sum, source) => sum + [...source.matchAll(/l10n\.t\(\s*"/gu)].length, 0),
    ).toBe(calls);
  });

  it("of the code are the ones in l10n/bundle.l10n.json", () => {
    const bundle = readJson("l10n/bundle.l10n.json");
    expect(Object.keys(bundle).toSorted()).toStrictEqual([...messages].toSorted());
    expect(Object.entries(bundle).filter(([key, value]) => key !== value)).toStrictEqual([]);
  });

  it("of the manifest are the ones in package.nls.json", () => {
    expect(Object.keys(readJson("package.nls.json")).toSorted()).toStrictEqual(
      [...nlsKeys].toSorted(),
    );
  });

  it("are translated into exactly the listed languages", () => {
    const translated = (pattern: RegExp, directory: string): string[] =>
      readdirSync(directory)
        .flatMap((name) => pattern.exec(name)?.[1] ?? [])
        .toSorted();
    expect(translated(/^bundle\.l10n\.(.+)\.json$/u, "l10n")).toStrictEqual(locales);
    expect(translated(/^package\.nls\.(.+)\.json$/u, ".")).toStrictEqual(locales);
  });
});

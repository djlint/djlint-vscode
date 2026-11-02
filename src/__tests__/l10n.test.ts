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

function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted((a, b) => a.localeCompare(b));
}

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
function kept(strings: Record<string, string>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(strings).map(([key, text]) => [
      key,
      sorted(text.matchAll(/\{\d+\}|`[^`]*`|#[\w.]+#|https?:\/\/[^\s)]+/gu).map(([part]) => part)),
    ]),
  );
}

function translatedLocales(pattern: RegExp, directory: string): string[] {
  return sorted(
    readdirSync(directory).flatMap((name) => pattern.exec(name)?.groups?.["locale"] ?? []),
  );
}

const sources = sourceFiles("src").map((file) => readFileSync(file, "utf8"));
const messages = new Set(
  sources.flatMap((source) =>
    source
      .matchAll(/l10n\.t\(\s*(?<literal>"(?:[^"\\]|\\.)*")/gu)
      .map((match) => JSON.parse(match.groups?.["literal"] ?? "") as string)
      .toArray(),
  ),
);

const manifest = readFileSync("package.json", "utf8");
const nlsKeys = new Set(
  manifest.matchAll(/"%(?<key>[^%"]+)%"/gu).map((match) => match.groups?.["key"] ?? ""),
);

describe.each([
  { english: readJson("l10n/bundle.l10n.json"), file: "l10n/bundle.l10n.{0}.json" },
  { english: readJson("package.nls.json"), file: "package.nls.{0}.json" },
])("$file", ({ english, file }) => {
  it.each(locales)("%s translates every string, keeping what is not prose", (locale) => {
    const translation = readJson(file.replace("{0}", locale));
    expect(sorted(Object.keys(translation))).toStrictEqual(sorted(Object.keys(english)));
    expect(Object.entries(translation).filter(([, text]) => text.trim() === "")).toStrictEqual([]);
    expect(kept(translation)).toStrictEqual(kept(english));
  });
});

describe("the English strings", () => {
  it("are all literals, so they can be listed", () => {
    const calls = sources.reduce((sum, source) => sum + source.split("l10n.t(").length - 1, 0);
    const literals = sources.reduce(
      (sum, source) => sum + source.matchAll(/l10n\.t\(\s*"/gu).toArray().length,
      0,
    );
    expect(calls).toBeGreaterThan(0);
    expect(literals).toBe(calls);
  });

  it("of the code are the ones in l10n/bundle.l10n.json", () => {
    const bundle = readJson("l10n/bundle.l10n.json");
    expect(sorted(Object.keys(bundle))).toStrictEqual(sorted(messages));
    expect(Object.entries(bundle).filter(([key, value]) => key !== value)).toStrictEqual([]);
  });

  it("of the manifest are the ones in package.nls.json", () => {
    expect(sorted(Object.keys(readJson("package.nls.json")))).toStrictEqual(sorted(nlsKeys));
  });

  it("are translated into exactly the listed languages", () => {
    expect(translatedLocales(/^bundle\.l10n\.(?<locale>.+)\.json$/u, "l10n")).toStrictEqual(
      locales,
    );
    expect(translatedLocales(/^package\.nls\.(?<locale>.+)\.json$/u, ".")).toStrictEqual(locales);
  });
});

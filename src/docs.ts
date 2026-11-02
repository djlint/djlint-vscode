import * as vscode from "vscode";

// The folders of djlint.com's translations, by VS Code's display language.
const siteLocales: Readonly<Record<string, string>> = {
  cs: "cs",
  de: "de",
  es: "es",
  fr: "fr",
  it: "it",
  ja: "ja",
  ko: "ko",
  pl: "pl",
  "pt-br": "pt-br",
  ru: "ru",
  tr: "tr",
  "zh-cn": "zh",
  "zh-tw": "zh-tw",
};

// A page of the djLint docs, in the display language of VS Code where the site has it.
export function docsUrl(page: string): string {
  const locale = siteLocales[vscode.env.language.toLowerCase()];
  return `https://djlint.com/${locale ? `${locale}/` : ""}docs/${page}`;
}

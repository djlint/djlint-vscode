import * as vscode from "vscode";
import { getConfig } from "./config.js";

function languages(): string[] {
  return [...(getConfig().get<readonly string[]>("formatLanguages") ?? [])];
}

export class DjlintStatus implements vscode.Disposable {
  readonly #item = vscode.languages.createLanguageStatusItem(
    "djlint",
    languages(),
  );

  constructor() {
    this.#item.name = "djLint";
    this.#item.text = "djLint";
    this.#item.command = { command: "djlint.showLogs", title: "Open Logs" };
  }

  update(version: string, source: string): void {
    this.#item.text = `djLint ${version}`;
    this.#item.detail = source;
  }

  refreshLanguages(): void {
    this.#item.selector = languages();
  }

  dispose(): void {
    this.#item.dispose();
  }
}

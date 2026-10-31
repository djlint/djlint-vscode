import * as vscode from "vscode";
import { getConfig } from "./config.js";
import { directoryScopeKey } from "./paths.js";

interface InUse {
  source: string;
  version: string;
}

function languages(): string[] {
  return [...(getConfig().get<readonly string[]>("formatLanguages") ?? [])];
}

export class DjlintStatus implements vscode.Disposable {
  readonly #item = vscode.languages.createLanguageStatusItem(
    "djlint",
    languages(),
  );
  readonly #inUse = new Map<string, InUse>();
  readonly #editorChange: vscode.Disposable;

  constructor() {
    this.#item.name = "djLint";
    this.#item.command = { command: "djlint.showLogs", title: "Open Logs" };
    this.#editorChange = vscode.window.onDidChangeActiveTextEditor(() => {
      this.#render();
    });
    this.#render();
  }

  update(document: vscode.TextDocument, version: string, source: string): void {
    const inUse = { source, version };
    this.#inUse.set(document.uri.toString(), inUse);
    this.#inUse.set(directoryScopeKey(document), inUse);
    this.#render();
  }

  clear(): void {
    this.#inUse.clear();
    this.#render();
  }

  refreshLanguages(): void {
    this.#item.selector = languages();
  }

  dispose(): void {
    this.#editorChange.dispose();
    this.#item.dispose();
  }

  #render(): void {
    const document = vscode.window.activeTextEditor?.document;
    const inUse =
      document &&
      (this.#inUse.get(document.uri.toString()) ??
        this.#inUse.get(directoryScopeKey(document)));
    this.#item.text = inUse?.version ? `djLint ${inUse.version}` : "djLint";
    this.#item.detail = inUse?.source ?? "";
  }
}

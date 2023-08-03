import vscode from "vscode";
import { lintingArgs } from "./args";
import { getConfig } from "./config";
import { runDjlint } from "./runner";

export class Linter {
  static readonly #outputRegex =
    /^<filename>(?<filename>.*)<\/filename><line>(?<line>\d+):(?<column>\d+)<\/line><code>(?<code>.+)<\/code><message>(?<message>.+)<\/message>$/gmu;
  static readonly #oldOutputRegex =
    /^(?<code>[A-Z]+\d+)\s+(?<line>\d+):(?<column>\d+)\s+(?<message>.+)$/gmu;
  readonly #collection: vscode.DiagnosticCollection;
  readonly #context: vscode.ExtensionContext;
  readonly #outputChannel: vscode.LogOutputChannel;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.LogOutputChannel,
  ) {
    this.#collection = vscode.languages.createDiagnosticCollection("djLint");
    context.subscriptions.push(this.#collection);
    this.#context = context;
    this.#outputChannel = outputChannel;
  }

  async activate(): Promise<void> {
    const tryLint = async (doc: vscode.TextDocument): Promise<void> => {
      try {
        await this.#lintDocument(doc);
      } catch {}
    };

    this.#context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(async (doc) => {
        if (doc.uri.scheme !== "git") {
          await tryLint(doc);
        }
      }),
      vscode.workspace.onDidSaveTextDocument(tryLint),
      vscode.workspace.onDidCloseTextDocument((doc) =>
        this.#collection.delete(doc.uri),
      ),
    );

    await this.#lintEditors(vscode.window.visibleTextEditors);
  }

  async #lintEditors(editors: readonly vscode.TextEditor[]): Promise<void> {
    try {
      for (const editor of editors) {
        await this.#lintDocument(editor.document);
      }
    } catch {}
  }

  async #lintDocument(document: vscode.TextDocument): Promise<void> {
    const config = getConfig(document);

    if (!config.get<boolean>("enableLinting")) {
      this.#collection.delete(document.uri);
      return;
    }

    const stdout = await runDjlint(
      document,
      config,
      lintingArgs,
      this.#outputChannel,
    );

    const diags = [];
    const regex = config.get<boolean>("useNewLinterOutputParser")
      ? Linter.#outputRegex
      : Linter.#oldOutputRegex;
    for (const match of stdout.matchAll(regex)) {
      const groups = match.groups;
      if (groups == null) {
        continue;
      }
      const line = parseInt(groups["line"]) - 1;
      const column = parseInt(groups["column"]);
      const range = new vscode.Range(line, column, line, column);
      const message = `${groups["message"]} (${groups["code"]})`;
      const diag = new vscode.Diagnostic(range, message);
      diags.push(diag);
    }
    this.#collection.set(document.uri, diags);
  }
}

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
    const maybeLint = async (document: vscode.TextDocument): Promise<void> => {
      try {
        await this.#lint(document);
      } catch {}
    };

    this.#context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(maybeLint),
      vscode.workspace.onDidSaveTextDocument(maybeLint),
      vscode.workspace.onDidCloseTextDocument(({ uri }) =>
        this.#collection.delete(uri),
      ),
    );

    await this.#lintMany(
      vscode.window.visibleTextEditors.map(({ document }) => document),
    );
  }

  async #lintMany(documents: Iterable<vscode.TextDocument>): Promise<void> {
    try {
      for (const document of documents) {
        // eslint-disable-next-line no-await-in-loop
        await this.#lint(document);
      }
    } catch {}
  }

  async #lint(document: vscode.TextDocument): Promise<void> {
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
    for (const { groups } of stdout.matchAll(regex)) {
      if (groups) {
        const line = Number.parseInt(groups["line"]) - 1;
        const column = Number.parseInt(groups["column"]);
        const range = new vscode.Range(line, column, line, column);
        const message = `${groups["message"]} (${groups["code"]})`;
        const diag = new vscode.Diagnostic(range, message);
        diags.push(diag);
      }
    }
    this.#collection.set(document.uri, diags);
  }
}

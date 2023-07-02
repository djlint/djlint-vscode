import vscode from "vscode";
import { lintingArgs } from "./args";
import { getConfig } from "./config";
import { runDjlint } from "./runner";

export class Linter {
  protected static readonly outputRegex =
    /^<filename>(?<filename>.*)<\/filename><line>(?<line>\d+):(?<column>\d+)<\/line><code>(?<code>.+)<\/code><message>(?<message>.+)<\/message>$/gm;
  protected static readonly oldOutputRegex =
    /^(?<code>[A-Z]+\d+)\s+(?<line>\d+):(?<column>\d+)\s+(?<message>.+)$/gm;
  protected readonly collection: vscode.DiagnosticCollection;

  constructor(protected readonly context: vscode.ExtensionContext) {
    this.collection = vscode.languages.createDiagnosticCollection("djLint");
    this.context.subscriptions.push(this.collection);
  }

  async activate(): Promise<void> {
    const diagListener = async (doc: vscode.TextDocument): Promise<void> =>
      this.lintDocument(doc);

    this.context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(diagListener),
      vscode.workspace.onDidSaveTextDocument(diagListener),
      vscode.workspace.onDidCloseTextDocument((doc) =>
        this.collection.delete(doc.uri)
      ),
      vscode.window.onDidChangeVisibleTextEditors(async (visibleEditors) => {
        const unlintedEditors = visibleEditors.filter(
          (editor) => !this.collection.has(editor.document.uri)
        );
        await this.lintEditors(unlintedEditors);
      })
    );

    await this.lintEditors(vscode.window.visibleTextEditors);
  }

  protected async lintEditors(
    editors: readonly vscode.TextEditor[]
  ): Promise<void> {
    for (const editor of editors) {
      await this.lintDocument(editor.document);
    }
  }

  protected async lintDocument(document: vscode.TextDocument): Promise<void> {
    const config = getConfig(document);

    if (!config.get<boolean>("enableLinting")) {
      this.collection.delete(document.uri);
      return;
    }

    const stdout = await runDjlint(document, config, lintingArgs);

    const diags = [];
    const regex = config.get<boolean>("useNewLinterOutputParser")
      ? Linter.outputRegex
      : Linter.oldOutputRegex;
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
    this.collection.set(document.uri, diags);
  }
}

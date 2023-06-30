import vscode from "vscode";
import { lintingArgs } from "./args";
import { configSection, getConfig } from "./config";
import { runDjlint } from "./runner";

export class Linter {
  protected static readonly parseRegex = /^([A-Z]+\d+)\s+(\d+):(\d+)\s+(.+)$/gm;
  protected readonly collection: vscode.DiagnosticCollection;
  protected readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
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
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration(`${configSection}.enableLinting`)) {
          if (getConfig().get<boolean>("enableLinting")) {
            await this.lintVisibleEditors();
          } else {
            this.collection.clear();
          }
        }
      })
    );

    await this.lintVisibleEditors();
  }

  protected async lintVisibleEditors(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      await this.lintDocument(editor.document);
    }
  }

  protected async lintDocument(document: vscode.TextDocument): Promise<void> {
    const config = getConfig();
    if (!config.get<boolean>("enableLinting")) {
      return;
    }

    const languages = config.get<Record<string, string>>("languages");
    if (
      languages == null ||
      !Object.keys(languages).includes(document.languageId)
    ) {
      return;
    }

    let stdout;
    try {
      stdout = await runDjlint(document, config, lintingArgs);
    } catch {
      return;
    }

    const diags = [];
    const matches = stdout.matchAll(Linter.parseRegex);
    for (const match of matches) {
      const line = parseInt(match[2]) - 1;
      const column = parseInt(match[3]);
      const range = new vscode.Range(line, column, line, column);
      const message = `${match[4]} (${match[1]})`;
      const diag = new vscode.Diagnostic(range, message);
      diags.push(diag);
    }
    this.collection.set(document.uri, diags);
  }
}

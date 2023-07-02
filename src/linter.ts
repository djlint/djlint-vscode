import vscode from "vscode";
import { lintingArgs } from "./args";
import { configSection, getConfig } from "./config";
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
    const diagListener = async (doc: vscode.TextDocument): Promise<void> => {
      const config = getConfig();
      if (this.lintingEnabled(config)) {
        await this.lintDocument(doc, config);
      }
    };

    this.context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(diagListener),
      vscode.workspace.onDidSaveTextDocument(diagListener),
      vscode.workspace.onDidCloseTextDocument((doc) =>
        this.collection.delete(doc.uri)
      ),
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration(`${configSection}.enableLinting`)) {
          const config = getConfig();
          if (this.lintingEnabled(config)) {
            await this.lintVisibleEditors(config);
          } else {
            this.collection.clear();
          }
        }
      })
    );

    const config = getConfig();
    if (this.lintingEnabled(config)) {
      await this.lintVisibleEditors(config);
    }
  }

  protected async lintVisibleEditors(
    config: vscode.WorkspaceConfiguration
  ): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      await this.lintDocument(editor.document, config);
    }
  }

  protected async lintDocument(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration
  ): Promise<void> {
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

  protected lintingEnabled(
    config: vscode.WorkspaceConfiguration
  ): boolean | undefined {
    return config.get<boolean>("enableLinting");
  }
}

import * as vscode from "vscode";
import { supportedLanguages } from "./constants";
import { Formatter } from "./formatter";
import { refreshDiagnostics } from "./linter";

export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("djLint");
  if (vscode.window.activeTextEditor) {
    void refreshDiagnostics(
      vscode.window.activeTextEditor.document,
      collection
    );
  }
  const diagListener = (doc: vscode.TextDocument) =>
    void refreshDiagnostics(doc, collection);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(diagListener),
    vscode.workspace.onDidSaveTextDocument(diagListener),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );

  vscode.languages.registerDocumentFormattingEditProvider(
    supportedLanguages,
    new Formatter()
  );
}

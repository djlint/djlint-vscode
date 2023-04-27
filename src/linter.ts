import * as vscode from "vscode";
import { lintingArgs } from "./args";
import { supportedLanguages } from "./constants";
import { runDjlint } from "./runner";
import { getConfig } from "./utils";

const lintRegex = /^([A-Z]+\d+)\s+(\d+):(\d+)\s+(.+)$/gm;

export async function refreshDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  if (!supportedLanguages.includes(document.languageId)) {
    return;
  }

  const config = getConfig();
  if (!config.get<boolean>("enableLinting")) {
    return;
  }

  let stdout;
  try {
    stdout = await runDjlint(config, document, lintingArgs);
  } catch {
    return;
  }

  const diags = [];
  const matches = stdout.matchAll(lintRegex);
  for (const match of matches) {
    const line = parseInt(match[2]) - 1;
    const column = parseInt(match[3]);
    const range = new vscode.Range(line, column, line, column);
    const message = `${match[4]} (${match[1]})`;
    const diag = new vscode.Diagnostic(range, message);
    diags.push(diag);
  }
  collection.set(document.uri, diags);
}

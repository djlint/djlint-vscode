import * as vscode from "vscode";
import { getCommonArgs } from "./args";
import { supportedLanguages } from "./constants";
import { runDjlint } from "./runner";
import { getConfig } from "./utils";

const lintRegex = /^([A-Z]+\d+)\s+(\d+):(\d+)\s+(.+)$/gm;

function getLintArgs(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration
): string[] {
  const args = ["--lint"].concat(getCommonArgs(document, config));

  const ignore = config.get<string[]>("ignore");
  if (ignore !== undefined && ignore.length !== 0) {
    args.push("--ignore", ignore.join(","));
  }

  const include = config.get<string[]>("include");
  if (include !== undefined && include.length !== 0) {
    args.push("--include", include.join(","));
  }

  return args;
}

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

  const args = getLintArgs(document, config);
  let stdout;
  try {
    stdout = await runDjlint(document, config, args);
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

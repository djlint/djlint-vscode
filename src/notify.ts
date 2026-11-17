import * as vscode from "vscode";

// Once until djLint's configuration may have changed, not once an engine: a warning comes back with every run, and every engine words it as the language server does, `djLint: <warning>`.
const shownWarnings = new Set<string>();

export function lastLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .findLast(Boolean);
}

export async function showFailure(
  message: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  const details = vscode.l10n.t("Details");
  const item = await vscode.window.showErrorMessage(message, details);
  if (item != null) {
    outputChannel.show();
  }
}

// As the language server does, which shows a warning again once the configuration changes.
export function forgetShownWarnings(): void {
  shownWarnings.clear();
}

export async function showWarning(
  message: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  if (shownWarnings.has(message)) {
    return;
  }
  shownWarnings.add(message);
  const details = vscode.l10n.t("Details");
  const item = await vscode.window.showWarningMessage(message, details);
  if (item != null) {
    outputChannel.show();
  }
}

import * as vscode from "vscode";

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

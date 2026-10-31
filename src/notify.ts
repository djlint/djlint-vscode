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
  const item = await vscode.window.showErrorMessage(message, "Details");
  if (item != null) {
    outputChannel.show();
  }
}

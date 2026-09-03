import * as vscode from "vscode";

export async function showFailure(
  message: string,
  outputChannel: vscode.LogOutputChannel,
): Promise<void> {
  const item = await vscode.window.showErrorMessage(message, "Details");
  if (item != null) {
    outputChannel.show();
  }
}

import * as vscode from "vscode";
import { IExtensionApi } from "./pythonExtTypes";

export async function getPythonExec(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration
): Promise<string> {
  if (config.get<boolean>("useVenv")) {
    const pythonExtension =
      vscode.extensions.getExtension<IExtensionApi>("ms-python.python");
    if (pythonExtension) {
      if (!pythonExtension.isActive) {
        await pythonExtension.activate();
      }
      const api = pythonExtension.exports;
      const environment = await api.environments.resolveEnvironment(
        api.environments.getActiveEnvironmentPath(document.uri)
      );
      const pythonExecUri = environment?.executable.uri;
      if (pythonExecUri) {
        return pythonExecUri.fsPath;
      }
      const errMsg = "Failed to get Python interpreter from Python extension.";
      void vscode.window.showErrorMessage(errMsg);
      throw new Error(errMsg);
    }
  }

  const pythonPath = config.get<string>("pythonPath");
  if (pythonPath) {
    return pythonPath;
  }

  const errMsg = "Invalid djlint.pythonPath setting.";
  void vscode.window.showErrorMessage(errMsg);
  throw new Error(errMsg);
}

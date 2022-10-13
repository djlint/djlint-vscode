import * as vscode from "vscode";

interface IExtensionApi {
  settings: {
    getExecutionDetails(resource?: vscode.Uri | undefined): {
      execCommand: string[] | undefined;
    };
  };
}

export async function getPythonExec(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration
): Promise<[string, string[]]> {
  if (config.get<boolean>("useVenv")) {
    const pythonExtension = vscode.extensions.getExtension("ms-python.python");
    if (pythonExtension) {
      const api = (
        pythonExtension.isActive
          ? pythonExtension.exports
          : await pythonExtension.activate()
      ) as IExtensionApi;
      const execCommand = api.settings.getExecutionDetails(
        document.uri
      ).execCommand;
      if (execCommand) {
        const executable = execCommand.shift();
        if (executable) {
          return [executable, execCommand];
        }
      }
      const errMsg = "Failed to get Python interpreter from Python extension.";
      void vscode.window.showErrorMessage(errMsg);
      throw new Error(errMsg);
    }
  }

  const pythonPath = config.get<string>("pythonPath");
  if (pythonPath) {
    return [pythonPath, []];
  }

  const errMsg = "Invalid djlint.pythonPath setting.";
  void vscode.window.showErrorMessage(errMsg);
  throw new Error(errMsg);
}

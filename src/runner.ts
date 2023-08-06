import { PythonExtension } from "@vscode/python-extension";
import { execa, type ExecaError } from "execa";
import vscode from "vscode";
import { configurationArg, type CliArg } from "./args";
import { configSection } from "./config";
import { checkErrors, ErrorMessageWrapper } from "./errors";

const supportedCwdUriSchemes = new Set(["file"]);

async function getPythonExec(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
): Promise<string> {
  if (config.get<boolean>("useVenv")) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const api = await PythonExtension.api().catch(() => {});
    if (api) {
      const environment = await api.environments.resolveEnvironment(
        api.environments.getActiveEnvironmentPath(document.uri),
      );
      const pythonExecUri = environment?.executable.uri;
      if (pythonExecUri) {
        return pythonExecUri.fsPath;
      }
      const msg = "Failed to get Python interpreter from Python extension.";
      throw new Error(msg);
    }
  }

  const pythonPath = config.get<string>("pythonPath");
  if (pythonPath) {
    return pythonPath;
  }

  const msg = `Invalid ${configSection}.pythonPath setting.`;
  throw new Error(msg);
}

function getCwd(
  childArgs: string[],
  document: vscode.TextDocument,
  outputChannel: vscode.LogOutputChannel,
): Record<string, never> | { cwd: string } {
  if (childArgs.includes(configurationArg.cliName)) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (
      workspaceFolder != null &&
      supportedCwdUriSchemes.has(workspaceFolder.uri.scheme)
    ) {
      return { cwd: workspaceFolder.uri.fsPath };
    }
  }
  if (supportedCwdUriSchemes.has(document.uri.scheme)) {
    const parentFolder = vscode.Uri.joinPath(document.uri, "..");
    return { cwd: parentFolder.fsPath };
  }
  outputChannel.warn(
    `Unsupported scheme "${document.uri.scheme}" for "${document.uri.fsPath}". Cwd will not be set.`,
  );
  return {};
}

export async function runDjlint(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: CliArg[],
  outputChannel: vscode.LogOutputChannel,
  formattingOptions?: vscode.FormattingOptions,
): Promise<string> {
  const pythonExec = await getPythonExec(document, config).catch((e: Error) => {
    void vscode.window.showErrorMessage(e.message);
    throw e;
  });
  const childArgs = [
    "-m",
    "djlint",
    "-",
    ...args.flatMap((arg) => arg.build(config, document, formattingOptions)),
  ];
  const childOptions = {
    ...getCwd(childArgs, document, outputChannel),
    input: document.getText(),
    stripFinalNewline: false,
  };
  return execa(pythonExec, childArgs, childOptions)
    .catch((e) => {
      checkErrors(e, pythonExec);
      return e;
    })
    .then(({ stdout }) => stdout)
    .catch((e: ErrorMessageWrapper<ExecaError> | ExecaError) => {
      void vscode.window.showErrorMessage(e.message, "Details").then((item) => {
        if (item != null) {
          outputChannel.show();
        }
      });
      if (e instanceof ErrorMessageWrapper) {
        e = e.wrappedError;
      }
      outputChannel.error(JSON.stringify(e, null, "\t"));
      throw e;
    });
}

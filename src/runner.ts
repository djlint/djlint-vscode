import { PythonExtension } from "@vscode/python-extension";
import { execa, type ExecaError } from "execa";
import * as vscode from "vscode";
import { configurationArg, type CliArg } from "./args.js";
import { configSection } from "./config.js";
import { checkErrors } from "./errors.js";
import { IsolatedDjlintRunner } from "./isolated-runner.js";
import { noop } from "./utils.js";

async function getPythonExec(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
): Promise<string> {
  if (config.get<boolean>("useVenv")) {
    const api = await PythonExtension.api().catch(noop);
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
  childArgs: readonly string[],
  document: vscode.TextDocument,
  outputChannel: vscode.LogOutputChannel,
): Record<string, never> | { cwd: string } {
  if (childArgs.includes(configurationArg.cliName)) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder != null) {
      if (workspaceFolder.uri.scheme === "file") {
        return { cwd: workspaceFolder.uri.fsPath };
      }
      outputChannel.warn(
        `Unsupported URI scheme of "${workspaceFolder.uri.toString()}". Cwd will not be set.`,
      );
      return {};
    }
  }
  if (document.uri.scheme === "file") {
    const parentFolder = vscode.Uri.joinPath(document.uri, "..");
    return { cwd: parentFolder.fsPath };
  }
  outputChannel.warn(
    `Unsupported URI scheme of "${document.uri.toString()}". Cwd will not be set.`,
  );
  return {};
}

type ChildOptions =
  | { input: string; stripFinalNewline: boolean; cwd: string }
  | { input: string; stripFinalNewline: boolean };
export type CustomExecaError = ExecaError<ChildOptions>;

// Global isolated djlint runner instance
let globalIsolatedRunner: IsolatedDjlintRunner | null = null;

function getIsolatedRunner(
  outputChannel: vscode.LogOutputChannel,
  extensionPath: string,
): IsolatedDjlintRunner {
  globalIsolatedRunner ??= new IsolatedDjlintRunner(outputChannel, extensionPath);
  return globalIsolatedRunner;
}

export async function runDjlint(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: readonly CliArg[],
  outputChannel: vscode.LogOutputChannel,
  formattingOptions?: vscode.FormattingOptions,
  extensionPath?: string,
): Promise<string> {
  // Try isolated runner first (new self-contained approach) if enabled
  if (extensionPath && config.get<boolean>("useIsolatedEnvironment")) {
    try {
      const isolatedRunner = getIsolatedRunner(outputChannel, extensionPath);
      return await isolatedRunner.runDjlint(
        document.getText(),
        args,
        document,
        config,
        formattingOptions,
      );
    } catch (e: unknown) {
      outputChannel.warn(`Isolated djLint execution failed, falling back to system Python: ${String(e)}`);
    }
  }
  
  // Fallback to original Python executable approach
  const pythonExec = await getPythonExec(document, config).catch((e_: Error) => {
    void vscode.window.showErrorMessage(e_.message);
    throw e_;
  });
  const childArgs = [
    "-m",
    "djlint",
    "-",
    ...args.flatMap((arg) => arg.build(config, document, formattingOptions)),
  ];
  const childOptions: ChildOptions = {
    ...getCwd(childArgs, document, outputChannel),
    input: document.getText(),
    stripFinalNewline: false,
  };
  return execa(pythonExec, childArgs, childOptions)
    .catch((e_: CustomExecaError) =>
      checkErrors(e_, outputChannel, config, pythonExec),
    )
    .then(({ stdout }) => stdout);
}

export function disposeIsolatedRunner(): void {
  if (globalIsolatedRunner) {
    globalIsolatedRunner.dispose();
    globalIsolatedRunner = null;
  }
}

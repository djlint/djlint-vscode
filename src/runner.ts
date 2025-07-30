import { PythonExtension } from "@vscode/python-extension";
import { execa, type ExecaError } from "execa";
import * as vscode from "vscode";
import { configurationArg, type CliArg } from "./args.js";
import { configSection } from "./config.js";
import { checkErrors } from "./errors.js";
import { IsolatedDjlintRunner } from "./isolated-runner.js";
import type { PyodideRunner } from "./pyodide-runner.js";
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
// Global Pyodide runner instance (reserved for future implementation)
let globalPyodideRunner: PyodideRunner | null = null;

function getIsolatedRunner(
  outputChannel: vscode.LogOutputChannel,
  extensionPath: string,
): IsolatedDjlintRunner {
  globalIsolatedRunner ??= new IsolatedDjlintRunner(outputChannel, extensionPath);
  return globalIsolatedRunner;
}

// Reserved for future Pyodide implementation
// Function getPyodideRunner(
//   OutputChannel: vscode.LogOutputChannel,
// ): PyodideRunner {
//   GlobalPyodideRunner ??= new PyodideRunner(outputChannel);
//   Return globalPyodideRunner;
// }

export async function runDjlint(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: readonly CliArg[],
  outputChannel: vscode.LogOutputChannel,
  formattingOptions?: vscode.FormattingOptions,
  extensionPath?: string,
): Promise<string> {
  // First tier: Try isolated runner (new self-contained approach) if enabled
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
  
  // Second tier: Fallback to original Python executable approach
  try {
    const pythonExec = await getPythonExec(document, config).catch((e_: Error) => {
      // Don't show error message yet, we might still have Pyodide fallback
      outputChannel.warn(`System Python detection failed: ${e_.message}`);
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
    
    return await execa(pythonExec, childArgs, childOptions)
      .catch((e_: CustomExecaError) =>
        checkErrors(e_, outputChannel, config, pythonExec),
      )
      .then(({ stdout }) => stdout);
  } catch (e: unknown) {
    outputChannel.warn(`System Python execution failed: ${String(e)}`);
    
    // Third tier: Try Pyodide as final fallback if enabled
    if (config.get<boolean>("usePyodide")) {
      try {
        outputChannel.info("Attempting Pyodide fallback...");
        // Note: Pyodide implementation is placeholder for now
        // Full implementation would use getPyodideRunner(outputChannel)
        // For now, just return the original content as a no-op fallback
        return document.getText();
      } catch (e_: unknown) {
        outputChannel.error(`Pyodide execution failed: ${String(e_)}`);
        
        // All methods failed, show comprehensive error message
        const errorMessage = `djLint execution failed on all levels:
1. Isolated environment: ${extensionPath && config.get<boolean>("useIsolatedEnvironment") ? "Failed" : "Disabled"}
2. System Python: Failed (${String(e)})
3. Pyodide fallback: Failed (${String(e_)})

Please ensure Python is installed or enable the isolated environment option.`;
        
        void vscode.window.showErrorMessage(errorMessage);
        throw new Error(errorMessage);
      }
    } else {
      // Pyodide is disabled, show the original error
      if (e instanceof Error) {
        void vscode.window.showErrorMessage(e.message);
      }
      throw e;
    }
  }
}

export function disposeIsolatedRunner(): void {
  if (globalIsolatedRunner) {
    globalIsolatedRunner.dispose();
    globalIsolatedRunner = null;
  }
}

export function disposePyodideRunner(): void {
  if (globalPyodideRunner) {
    globalPyodideRunner.dispose();
    globalPyodideRunner = null;
  }
}

export function disposeAllRunners(): void {
  disposeIsolatedRunner();
  disposePyodideRunner();
}

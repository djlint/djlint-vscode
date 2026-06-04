import { PythonExtension } from "@vscode/python-extension";
import { execa, type ExecaError } from "execa";
import * as vscode from "vscode";
import { configurationArg, type CliArg } from "./args.js";
import { configSection } from "./config.js";
import { checkErrors } from "./errors.js";
import { noop } from "./utils.js";

interface RunnerCommand {
  exec: string;
  prefixArgs: readonly string[];
}

interface RunnerCommands {
  fallback?: RunnerCommand;
  primary: RunnerCommand;
}

interface ErrorWithCode extends Error {
  code?: string;
}

async function getDjlintCommands(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
): Promise<RunnerCommands> {
  if (config.get<boolean>("useVenv")) {
    const api = await PythonExtension.api().catch(noop);
    if (api) {
      const environment = await api.environments
        .resolveEnvironment(
          api.environments.getActiveEnvironmentPath(document.uri),
        )
        .catch(noop);
      const pythonExecUri = environment?.executable.uri;
      if (pythonExecUri) {
        return {
          primary: { exec: pythonExecUri.fsPath, prefixArgs: ["-m", "djlint"] },
        };
      }
    }
    const msg = "Failed to get Python interpreter from Python extension.";
    throw new Error(msg);
  }

  const executablePath = config.get<string>("executablePath")?.trim();
  const pythonPath = config.get<string>("pythonPath")?.trim();
  if (executablePath && pythonPath) {
    return {
      fallback: { exec: pythonPath, prefixArgs: ["-m", "djlint"] },
      primary: { exec: executablePath, prefixArgs: [] },
    };
  }
  if (executablePath) {
    return { primary: { exec: executablePath, prefixArgs: [] } };
  }
  if (pythonPath) {
    return { primary: { exec: pythonPath, prefixArgs: ["-m", "djlint"] } };
  }

  const msg = `Invalid ${configSection}.executablePath and ${configSection}.pythonPath settings.`;
  throw new Error(msg);
}

function getCwd(
  childArgs: readonly string[],
  document: vscode.TextDocument,
  outputChannel: vscode.LogOutputChannel,
): { cwd?: string } {
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

interface ChildOptions {
  input: string;
  stripFinalNewline: boolean;
  cwd?: string;
  cancelSignal: AbortSignal;
}
export type CustomExecaError = ExecaError<ChildOptions>;

function isCommandNotFound(e: CustomExecaError): boolean {
  const errorWithCode: ErrorWithCode = e;
  return errorWithCode.code === "ENOENT";
}

async function runDjlintCommand(
  command: RunnerCommand,
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: readonly CliArg[],
  outputChannel: vscode.LogOutputChannel,
  abortController: AbortController,
  formattingOptions?: vscode.FormattingOptions,
): Promise<string> {
  const childArgs = [
    ...command.prefixArgs,
    "-",
    ...args.flatMap((arg) => arg.build(config, document, formattingOptions)),
  ];
  const childOptions: ChildOptions = {
    ...getCwd(childArgs, document, outputChannel),
    cancelSignal: abortController.signal,
    input: document.getText(),
    stripFinalNewline: false,
  };
  const { stdout } = await execa(command.exec, childArgs, childOptions);
  return stdout;
}

async function runDjlintWithFallback(
  commands: RunnerCommands,
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: readonly CliArg[],
  outputChannel: vscode.LogOutputChannel,
  abortController: AbortController,
  formattingOptions?: vscode.FormattingOptions,
): Promise<string> {
  return runDjlintCommand(
    commands.primary,
    document,
    config,
    args,
    outputChannel,
    abortController,
    formattingOptions,
  ).catch(async (e: CustomExecaError) => {
    if (commands.fallback != null && isCommandNotFound(e)) {
      return runDjlintCommand(
        commands.fallback,
        document,
        config,
        args,
        outputChannel,
        abortController,
        formattingOptions,
      ).catch(
        (e_: CustomExecaError) => checkErrors(e_, outputChannel, config).stdout,
      );
    }
    return checkErrors(e, outputChannel, config).stdout;
  });
}

export async function runDjlint(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: readonly CliArg[],
  outputChannel: vscode.LogOutputChannel,
  abortController: AbortController,
  formattingOptions?: vscode.FormattingOptions,
): Promise<string> {
  const commands = await getDjlintCommands(document, config).catch(
    (e: Error) => {
      void vscode.window.showErrorMessage(e.message);
      throw e;
    },
  );
  return runDjlintWithFallback(
    commands,
    document,
    config,
    args,
    outputChannel,
    abortController,
    formattingOptions,
  );
}

import path from "node:path";
import { PythonExtension } from "@vscode/python-extension";
import { execa, ExecaError } from "execa";
import * as vscode from "vscode";
import { configurationArg, rulesArg, type CliArg } from "./args.js";
import { configSection } from "./config.js";
import { checkErrors } from "./errors.js";

interface RunnerCommand {
  exec: string;
  prefixArgs: readonly string[];
}

interface RunnerCommands {
  fallback?: RunnerCommand;
  primary: RunnerCommand;
}

function isRelativePathLike(exec: string): boolean {
  return /[\\/]/u.test(exec) && !path.isAbsolute(exec);
}

function resolveConfiguredExecutablePath(
  exec: string,
  document: vscode.TextDocument,
): string {
  if (!isRelativePathLike(exec)) {
    return exec;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (workspaceFolder?.uri.scheme !== "file") {
    return exec;
  }

  return path.resolve(workspaceFolder.uri.fsPath, exec);
}

async function getDjlintCommands(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
): Promise<RunnerCommands> {
  if (config.get<boolean>("useVenv")) {
    let api;
    try {
      api = await PythonExtension.api();
    } catch {}
    if (api) {
      const environment = await api.environments.resolveEnvironment(
        api.environments.getActiveEnvironmentPath(document.uri),
      );
      const pythonExecUri = environment?.executable.uri;
      if (pythonExecUri) {
        return {
          primary: { exec: pythonExecUri.fsPath, prefixArgs: ["-m", "djlint"] },
        };
      }
      const msg = "Failed to get Python interpreter from Python extension.";
      throw new Error(msg);
    }
  }

  const executablePath = config.get<string>("executablePath")?.trim();
  const pythonPath = config.get<string>("pythonPath")?.trim();
  if (executablePath && pythonPath) {
    return {
      fallback: {
        exec: resolveConfiguredExecutablePath(pythonPath, document),
        prefixArgs: ["-m", "djlint"],
      },
      primary: {
        exec: resolveConfiguredExecutablePath(executablePath, document),
        prefixArgs: [],
      },
    };
  }
  if (executablePath) {
    return {
      primary: {
        exec: resolveConfiguredExecutablePath(executablePath, document),
        prefixArgs: [],
      },
    };
  }
  if (pythonPath) {
    return {
      primary: {
        exec: resolveConfiguredExecutablePath(pythonPath, document),
        prefixArgs: ["-m", "djlint"],
      },
    };
  }

  const msg = `Invalid ${configSection}.executablePath and ${configSection}.pythonPath settings.`;
  throw new Error(msg);
}

function getCwd(
  childArgs: readonly string[],
  document: vscode.TextDocument,
  outputChannel: vscode.LogOutputChannel,
): { cwd?: string } {
  if (
    childArgs.includes(configurationArg.cliName) ||
    childArgs.includes(rulesArg.cliName)
  ) {
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

export function isCustomExecaError(e: unknown): e is CustomExecaError {
  return e instanceof ExecaError;
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

export async function runDjlint(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  args: readonly CliArg[],
  outputChannel: vscode.LogOutputChannel,
  abortController: AbortController,
  formattingOptions?: vscode.FormattingOptions,
  hasFallback = false,
): Promise<string> {
  let commands;
  try {
    commands = await getDjlintCommands(document, config);
  } catch (e) {
    void vscode.window.showErrorMessage(
      // eslint-disable-next-line unicorn/prefer-error-is-error
      e instanceof Error ? e.message : String(e),
    );
    throw e;
  }

  try {
    return await runDjlintCommand(
      commands.primary,
      document,
      config,
      args,
      outputChannel,
      abortController,
      formattingOptions,
    );
  } catch (e) {
    if (!isCustomExecaError(e)) {
      throw e;
    }

    if (commands.fallback != null && e.code === "ENOENT") {
      try {
        return await runDjlintCommand(
          commands.fallback,
          document,
          config,
          args,
          outputChannel,
          abortController,
          formattingOptions,
        );
      } catch (e_) {
        if (!isCustomExecaError(e_)) {
          throw e_;
        }

        return checkErrors(e_, outputChannel, config, hasFallback).stdout;
      }
    }

    return checkErrors(e, outputChannel, config, hasFallback).stdout;
  }
}

import { execa } from "execa";
import * as vscode from "vscode";
import { formattingArgs, lintingArgs } from "./args.js";
import { configSection } from "./config.js";
import {
  isCustomExecaError,
  isDjlintUnavailable,
  type ChildOptions,
  type CustomExecaError,
} from "./engine/subprocess/exec.js";
import {
  DjlintUnavailableError,
  RESOLUTION_TTL_MS,
  RUN_TIMEOUT_MS,
  type DjlintMode,
} from "./engine/types.js";
import { checkErrors, isValidLintResult } from "./errors.js";
import { showFailure } from "./notify.js";
import { normalizeConfiguredExecutable, workspaceScopeKey } from "./paths.js";
import {
  getActivePythonEnvironment,
  resetPythonEnvironmentProviderIfUnavailable,
  type PythonEnvironmentDetails,
} from "./python/environment.js";
import {
  parseDjlintVersion,
  resetSkippedArgWarnings,
  selectSupportedArgs,
} from "./version.js";

export interface RunnerCommand {
  exec: string;
  prefixArgs: readonly string[];
  version: string;
}

type RunnerTarget = Omit<RunnerCommand, "version">;

const PROBE_TIMEOUT_MS = 10_000;

// eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable name
const EXTRA_ENV: NodeJS.ProcessEnv = { PYTHONSAFEPATH: "1" };

function toEnvironmentRunnerCommand(
  details: PythonEnvironmentDetails | null,
): RunnerTarget | null {
  if (details?.command == null) {
    return null;
  }
  return {
    exec: details.command.executable,
    prefixArgs: [...details.command.args, "-m", "djlint"],
  };
}

export interface ResolveDjlintCommandDeps {
  executablePath: string;
  pythonPath: string;
  useVenv: boolean | undefined;
  getActiveEnvironment:
    | ((
        uri: vscode.Uri | undefined,
      ) => Promise<PythonEnvironmentDetails | null>)
    | null;
  uri: vscode.Uri | undefined;
  probe: (
    exec: string,
    prefixArgs: readonly string[],
  ) => Promise<string | null>;
  onConfiguredPathRejected: (setting: string, exec: string) => void;
}

export async function resolveDjlintCommand(
  deps: ResolveDjlintCommandDeps,
): Promise<RunnerCommand> {
  const executablePath = deps.executablePath.trim();
  if (executablePath) {
    const version = await deps.probe(executablePath, []);
    if (version != null) {
      return { exec: executablePath, prefixArgs: [], version };
    }
    deps.onConfiguredPathRejected("executablePath", executablePath);
  }

  const pythonPath = deps.pythonPath.trim();
  if (pythonPath) {
    const prefixArgs = ["-m", "djlint"];
    const version = await deps.probe(pythonPath, prefixArgs);
    if (version != null) {
      return { exec: pythonPath, prefixArgs, version };
    }
    deps.onConfiguredPathRejected("pythonPath", pythonPath);
  }

  if (deps.useVenv !== false && deps.getActiveEnvironment) {
    const active = toEnvironmentRunnerCommand(
      await deps.getActiveEnvironment(deps.uri),
    );
    if (active) {
      const version = await deps.probe(active.exec, active.prefixArgs);
      if (version != null) {
        return { ...active, version };
      }
    }
  }

  const pathVersion = await deps.probe("djlint", []);
  if (pathVersion != null) {
    return { exec: "djlint", prefixArgs: [], version: pathVersion };
  }

  throw new DjlintUnavailableError(
    `Could not find djLint. Set ${configSection}.executablePath, ${configSection}.pythonPath, or install djLint so it is available on PATH.`,
  );
}

interface CommandCacheEntry {
  command: RunnerCommand;
  resolvedAt: number;
}

const commandCache = new Map<string, CommandCacheEntry>();
const inFlightResolutions = new Map<string, Promise<RunnerCommand>>();
const cacheEpoch = { value: 0 };

export function invalidateDjlintCommandCache(): void {
  cacheEpoch.value += 1;
  commandCache.clear();
  inFlightResolutions.clear();
  resetSkippedArgWarnings();
  resetPythonEnvironmentProviderIfUnavailable();
}

export async function resolveDjlintCommandCached(
  deps: ResolveDjlintCommandDeps,
  scopeKey: string,
): Promise<RunnerCommand> {
  const cached = commandCache.get(scopeKey);
  if (cached != null && Date.now() - cached.resolvedAt < RESOLUTION_TTL_MS) {
    return cached.command;
  }

  const pending =
    inFlightResolutions.get(scopeKey) ??
    (async (): Promise<RunnerCommand> => {
      const epochAtStart = cacheEpoch.value;
      const command = await resolveDjlintCommand(deps);
      const wasInvalidatedWhileResolving = epochAtStart !== cacheEpoch.value;
      if (!wasInvalidatedWhileResolving) {
        commandCache.set(scopeKey, { command, resolvedAt: Date.now() });
      }
      return command;
    })();
  inFlightResolutions.set(scopeKey, pending);
  try {
    return await pending;
  } finally {
    const isStillCurrent = inFlightResolutions.get(scopeKey) === pending;
    if (isStillCurrent) {
      inFlightResolutions.delete(scopeKey);
    }
  }
}

async function probeExecutable(
  exec: string,
  prefixArgs: readonly string[],
): Promise<string | null> {
  try {
    const result = await execa(exec, [...prefixArgs, "--version"], {
      env: EXTRA_ENV,
      reject: false,
      stdin: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });
    return result.exitCode === 0 ? parseDjlintVersion(result.stdout) : null;
  } catch {
    return null;
  }
}

export const resolutionSettingKeys: readonly string[] = [
  "executablePath",
  "pythonPath",
  "useVenv",
];

async function getDjlintCommand(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  outputChannel: vscode.LogOutputChannel,
): Promise<RunnerCommand> {
  function normalize(raw: string): string {
    return normalizeConfiguredExecutable(raw, document);
  }

  const executablePath = normalize(config.get<string>("executablePath") ?? "");
  const pythonPath = normalize(config.get<string>("pythonPath") ?? "");
  const useVenv = config.get<boolean>("useVenv");

  return resolveDjlintCommandCached(
    {
      executablePath,
      getActiveEnvironment:
        useVenv === false
          ? null
          : async (uri): Promise<PythonEnvironmentDetails | null> =>
              getActivePythonEnvironment(uri),
      onConfiguredPathRejected: (setting, exec): void => {
        outputChannel.warn(
          `${configSection}.${setting} is set to "${exec}", but no working djLint was found there. Ignoring it and trying the next candidate.`,
        );
      },
      probe: probeExecutable,
      pythonPath,
      uri: document.uri,
      useVenv,
    },
    workspaceScopeKey(document),
  );
}

const schemesWarnedAboutCwd = new Set<string>();

function getCwd(
  document: vscode.TextDocument,
  outputChannel: vscode.LogOutputChannel,
): { cwd?: string } {
  const { scheme } = document.uri;
  if (scheme === "file") {
    return { cwd: vscode.Uri.joinPath(document.uri, "..").fsPath };
  }
  if (!schemesWarnedAboutCwd.has(scheme)) {
    schemesWarnedAboutCwd.add(scheme);
    outputChannel.warn(
      `djLint cannot be run from the folder of a "${scheme}" document, so configuration files next to it are not found.`,
    );
  }
  return {};
}

async function runDjlintCommand(
  command: RunnerCommand,
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  mode: DjlintMode,
  outputChannel: vscode.LogOutputChannel,
  cancelSignal: AbortSignal,
  formattingOptions: vscode.FormattingOptions | undefined,
): Promise<string> {
  const supportedArgs = selectSupportedArgs(
    mode === "format" ? formattingArgs : lintingArgs,
    command.version,
    outputChannel,
  );
  const childArgs = [
    ...command.prefixArgs,
    "-",
    ...supportedArgs.flatMap((arg) =>
      arg.build(config, document, formattingOptions),
    ),
  ];
  const childOptions: ChildOptions = {
    ...getCwd(document, outputChannel),
    cancelSignal,
    env: EXTRA_ENV,
    input: document.getText(),
    stripFinalNewline: false,
    timeout: RUN_TIMEOUT_MS,
  };
  const { stdout } = await execa(command.exec, childArgs, childOptions);
  return stdout;
}

export type RunFailureClassification = "error" | "lint-result" | "unavailable";

export async function classifyRunFailure(
  e: CustomExecaError,
  isValidResult: (e: CustomExecaError) => boolean,
  isUnavailableFast: (e: CustomExecaError) => boolean,
  reprobe: () => Promise<string | null>,
): Promise<RunFailureClassification> {
  if (isValidResult(e)) {
    return "lint-result";
  }
  if (isUnavailableFast(e)) {
    return "unavailable";
  }
  const version = await reprobe();
  return version == null ? "unavailable" : "error";
}

export async function runDjlint(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
  mode: DjlintMode,
  outputChannel: vscode.LogOutputChannel,
  cancelSignal: AbortSignal,
  formattingOptions?: vscode.FormattingOptions,
): Promise<string> {
  let command;
  try {
    command = await getDjlintCommand(document, config, outputChannel);
  } catch (e) {
    if (e instanceof DjlintUnavailableError) {
      outputChannel.debug(`${e.message} Using the bundled runtime.`);
    } else {
      // eslint-disable-next-line unicorn/prefer-error-is-error
      const message = e instanceof Error ? e.message : String(e);
      outputChannel.error(message);
      void showFailure(message, outputChannel);
    }
    throw e;
  }

  try {
    return await runDjlintCommand(
      command,
      document,
      config,
      mode,
      outputChannel,
      cancelSignal,
      formattingOptions,
    );
  } catch (e) {
    if (!isCustomExecaError(e) || e.isCanceled) {
      throw e;
    }

    const classification = await classifyRunFailure(
      e,
      (err) => isValidLintResult(err, mode === "lint"),
      isDjlintUnavailable,
      async () => probeExecutable(command.exec, command.prefixArgs),
    );

    if (classification === "lint-result") {
      return e.stdout;
    }

    if (classification === "unavailable") {
      invalidateDjlintCommandCache();
      outputChannel.debug(
        `External djLint not available (${e.shortMessage}); using the bundled runtime.`,
      );
      throw new DjlintUnavailableError("External djLint is not available.", {
        cause: e,
      });
    }

    return checkErrors(e, outputChannel);
  }
}

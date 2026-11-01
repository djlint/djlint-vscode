import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execa } from "execa";
import * as vscode from "vscode";
import { whichCommand } from "which-command";
import { buildOptions, formattingArgs, lintingArgs } from "../../args.js";
import type { ArgContext } from "../../args.js";
import { configSection, getConfiguredPath } from "../../config.js";
import { showFailure } from "../../notify.js";
import {
  directoryScopeKey,
  normalizeConfiguredExecutable,
  workspaceScopeKey,
} from "../../paths.js";
import type { PythonEnvironments } from "../../python/environment.js";
import type { DjlintStatus } from "../../status.js";
import { getExistingDocumentFolder } from "../document-folder.js";
import { DjlintUnavailableError, RUN_TIMEOUT_MS } from "../types.js";
import type { DjlintEngine, DjlintMode, LintDiagnostic } from "../types.js";
import { checkErrors, isValidLintResult } from "./errors.js";
import { isCustomExecaError, isDjlintUnavailable } from "./exec.js";
import type { ChildOptions, CustomExecaError } from "./exec.js";
import { parseLinterOutput } from "./parse-lint-output.js";
import { CommandResolver } from "./resolve.js";
import type { ProbeResult, RunnerCommand } from "./resolve.js";
import { DjlintServer, ServerResponseError } from "./server.js";
import type { ServerSettings } from "./server.js";
import {
  isVersionAtLeast,
  parseDjlintVersion,
  selectSupportedArgs,
} from "./version.js";

const PROBE_TIMEOUT_MS = 10_000;
const LANGUAGE_SERVER_MIN_VERSION = "1.49";

// A custom rule's python_module used to be found because djLint ran from the workspace root whenever these two were set.
function moduleSearchEnv({
  config,
  document,
}: ArgContext): { env: NodeJS.ProcessEnv } | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (
    folder?.uri.scheme !== "file" ||
    [config.get<string>("configuration"), config.get<string>("rules")].every(
      (value) => !value,
    )
  ) {
    return void 0;
  }
  const { PYTHONPATH: inherited } = process.env;
  return {
    env: {
      PYTHONPATH: [folder.uri.fsPath, ...(inherited ? [inherited] : [])].join(
        path.delimiter,
      ),
    },
  };
}

/** The variables `ruff.path` accepts, except `${cwd}`, which means nothing to an extension. */
export function expandVariables(
  value: string,
  document: vscode.TextDocument,
): string {
  function workspaceFolderPath(name?: string): string | undefined {
    const folder =
      name == null
        ? vscode.workspace.getWorkspaceFolder(document.uri)
        : vscode.workspace.workspaceFolders?.find(
            (candidate) => candidate.name === name,
          );
    return folder?.uri.scheme === "file" ? folder.uri.fsPath : void 0;
  }

  return value.replaceAll(/\$\{(?<variable>[^}]+)\}/gu, (match, variable) => {
    const [kind = "", ...rest] = String(variable).split(":");
    const argument = rest.join(":");
    switch (kind) {
      case "env": {
        return process.env[argument] ?? "";
      }
      case "userHome": {
        return os.homedir();
      }
      case "workspaceFolder": {
        return workspaceFolderPath(argument || void 0) ?? match;
      }
      default: {
        return match;
      }
    }
  });
}

type RunFailureClassification = "error" | "lint-result" | "unavailable";

export async function classifyRunFailure(
  e: CustomExecaError,
  isValidResult: (e: CustomExecaError) => boolean,
  isUnavailableFast: (e: CustomExecaError) => boolean,
  reprobe: () => Promise<ProbeResult>,
): Promise<RunFailureClassification> {
  if (isValidResult(e)) {
    return "lint-result";
  }
  if (isUnavailableFast(e)) {
    return "unavailable";
  }
  return (await reprobe()) === null ? "unavailable" : "error";
}

// On Windows, execa leaves a command it cannot find to cmd.exe, which exits 1 with a message in the language of the system.
// Like execa, this tries the extension a command is written with, even one PATHEXT lacks: execa runs such a script by its shebang.
async function isCommandFound(
  exec: string,
  cwd: string | undefined,
): Promise<boolean> {
  const extension = path.extname(exec);
  const found = await whichCommand(exec, {
    ...(cwd != null && { cwd }),
    ...(extension && {
      pathExt: [extension, process.env["PATHEXT"] ?? ""].join(path.delimiter),
    }),
  });
  return found !== void 0;
}

// Version managers' shims pick the Python of the folder they run from.
async function probeExecutable(
  exec: string,
  prefixArgs: readonly string[],
  document: vscode.TextDocument,
): Promise<ProbeResult> {
  const cwd = await getExistingDocumentFolder(document);
  if (!(await isCommandFound(exec, cwd))) {
    return null;
  }
  try {
    const result = await execa(exec, [...prefixArgs, "--version"], {
      ...(cwd != null && { cwd }),
      reject: false,
      stdin: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      return parseDjlintVersion(result.stdout);
    }
    return isDjlintUnavailable(result) ? null : void 0;
  } catch {
    return null;
  }
}

export class SubprocessEngine implements DjlintEngine {
  readonly #resolver = new CommandResolver();
  readonly #servers = new Map<string, DjlintServer>();
  readonly #brokenServers = new Set<string>();
  readonly #loggedCommands = new Set<string>();
  readonly #loggedWarnings = new Set<string>();
  readonly #warnedSkippedArgs = new Set<string>();
  readonly #schemesWarnedAboutCwd = new Set<string>();
  readonly #outputChannel: vscode.LogOutputChannel;
  readonly #pythonEnvironments: PythonEnvironments;
  readonly #status: DjlintStatus;
  readonly #environmentChange: vscode.Disposable;
  readonly #folderChange: vscode.Disposable;
  #disposed = false;

  constructor(
    outputChannel: vscode.LogOutputChannel,
    pythonEnvironments: PythonEnvironments,
    status: DjlintStatus,
  ) {
    this.#outputChannel = outputChannel;
    this.#pythonEnvironments = pythonEnvironments;
    this.#status = status;
    this.#environmentChange = pythonEnvironments.onDidChange(() => {
      this.#resolver.invalidate();
      this.#stopServers();
    });
    this.#folderChange = vscode.workspace.onDidChangeWorkspaceFolders(
      ({ removed }) => {
        const gone = [...this.#servers].filter(([key]) =>
          removed.some(({ uri }) => key.startsWith(`${uri.fsPath}\0`)),
        );
        for (const [key, server] of gone) {
          server.dispose();
          this.#servers.delete(key);
        }
      },
    );
  }

  async format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const context = { config, document, formattingOptions };
    const { epoch } = this.#resolver;
    const command = await this.#getCommand(document, config);
    const served = await this.#viaServer(
      command,
      context,
      "format",
      async (server, settings) =>
        server.format(document, settings, formattingOptions, token),
      epoch,
    );
    if (served != null) {
      return served;
    }
    const output = await this.#run("format", context, token, command);
    // Something else answering to the command, such as a djlint.py beside the template, must not empty the document.
    if (output.trim() === "" && document.getText().trim() !== "") {
      const message =
        "djLint printed nothing for a document with content, so the document was left as it is.";
      this.#outputChannel.error(message);
      void showFailure(message, this.#outputChannel);
      throw new Error(message);
    }
    return output;
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    const context = { config, document };
    const { epoch } = this.#resolver;
    const command = await this.#getCommand(document, config);
    const served = await this.#viaServer(
      command,
      context,
      "lint",
      async (server, settings) => server.lint(document, settings, token),
      epoch,
    );
    return (
      served ??
      parseLinterOutput(await this.#run("lint", context, token, command))
    );
  }

  dispose(): void {
    this.#disposed = true;
    this.#environmentChange.dispose();
    this.#folderChange.dispose();
    this.#stopServers();
  }

  #stopServers(): void {
    for (const server of this.#servers.values()) {
      server.dispose();
    }
    this.#servers.clear();
  }

  // Nothing here is required: on any failure the run goes through the command line, as for an older djLint.
  async #viaServer<R>(
    command: RunnerCommand,
    context: ArgContext,
    mode: DjlintMode,
    call: (server: DjlintServer, settings: ServerSettings) => Promise<R>,
    epoch: number,
  ): Promise<R | undefined> {
    const { document } = context;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (
      // Stopped while the command was looked up: nothing would stop a server started now.
      this.#disposed ||
      epoch !== this.#resolver.epoch ||
      command.version == null ||
      !isVersionAtLeast(command.version, LANGUAGE_SERVER_MIN_VERSION) ||
      moduleSearchEnv(context) != null ||
      // A file on its own would keep its folder in use, and Windows wouldn't let the user delete it.
      folder?.uri.scheme !== "file"
    ) {
      return void 0;
    }
    const cwd = folder.uri.fsPath;
    const key = [
      cwd,
      command.exec,
      ...command.prefixArgs,
      command.version,
    ].join("\0");
    if (this.#brokenServers.has(key)) {
      return void 0;
    }
    const { options, pathOptions } = buildOptions(
      { ...context, djlintVersion: command.version },
      mode,
    );
    let server = this.#servers.get(key);
    try {
      if (server == null || server.isClosed) {
        server = new DjlintServer(
          command.exec,
          command.prefixArgs,
          cwd,
          command.version,
          this.#outputChannel,
        );
        this.#servers.set(key, server);
      }
      return await call(server, { ...options, ...pathOptions });
    } catch (e) {
      if (e instanceof vscode.CancellationError) {
        throw e;
      }
      if (server?.isStopping || e instanceof ServerResponseError) {
        return void 0;
      }
      this.#brokenServers.add(key);
      server?.dispose();
      this.#outputChannel.warn(
        `djLint's language server failed, so djLint runs from the command line until a restart: ${String(e)}`,
      );
      return void 0;
    }
  }

  async #getCommand(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
  ): Promise<RunnerCommand> {
    const epochAtStart = this.#resolver.epoch;
    const activeEnvironment = config.get<boolean>("useVenv")
      ? await this.#pythonEnvironments.getActive(document.uri)
      : null;
    function configuredExecutable(
      key: Parameters<typeof getConfiguredPath>[1],
    ): string {
      return normalizeConfiguredExecutable(
        expandVariables(getConfiguredPath(config, key), document),
        document,
      );
    }
    const executablePath = configuredExecutable("executablePath");
    const pythonPath = configuredExecutable("pythonPath");
    // A language can set its own paths, and a workspace folder can hold projects with environments of their own.
    const scopeKey = [
      workspaceScopeKey(document),
      executablePath,
      pythonPath,
      ...(activeEnvironment?.command == null
        ? []
        : [
            activeEnvironment.command.executable,
            ...activeEnvironment.command.args,
          ]),
    ].join("\0");
    const command = await this.#resolver.resolve(
      {
        activeEnvironment,
        executablePath,
        onConfiguredPathRejected: (setting, exec): void => {
          this.#outputChannel.warn(
            `${configSection}.${setting} is set to "${exec}", but no working djLint was found there. Ignoring it and trying the next candidate.`,
          );
        },
        probe: async (exec, prefixArgs): Promise<ProbeResult> =>
          probeExecutable(exec, prefixArgs, document),
        pythonPath,
      },
      scopeKey,
      directoryScopeKey(document),
    );
    const source = [command.exec, ...command.prefixArgs].join(" ");
    if (epochAtStart === this.#resolver.epoch) {
      this.#status.update(document, command.version ?? "", source);
    }
    const description = `djLint ${command.version ?? "of unknown version"}: ${source}`;
    const logKey = [workspaceScopeKey(document), description].join("\0");
    if (!this.#loggedCommands.has(logKey)) {
      this.#loggedCommands.add(logKey);
      this.#outputChannel.info(`Using ${description}`);
    }
    return command;
  }

  async #getCwd(document: vscode.TextDocument): Promise<{ cwd?: string }> {
    const cwd = await getExistingDocumentFolder(document);
    if (cwd != null) {
      return { cwd };
    }
    const { scheme } = document.uri;
    if (!this.#schemesWarnedAboutCwd.has(scheme)) {
      this.#schemesWarnedAboutCwd.add(scheme);
      this.#outputChannel.warn(
        `djLint cannot be run from the folder of "${document.uri.toString()}", so configuration files next to it are not found.`,
      );
    }
    return {};
  }

  async #exec(
    command: RunnerCommand,
    mode: DjlintMode,
    context: ArgContext,
    cancelSignal: AbortSignal,
  ): Promise<string> {
    const versionedContext = { ...context, djlintVersion: command.version };
    const supportedArgs = selectSupportedArgs(
      mode === "format" ? formattingArgs : lintingArgs,
      command.version,
      versionedContext,
      this.#warnedSkippedArgs,
      this.#outputChannel,
    );
    const childArgs = [
      ...command.prefixArgs,
      "-",
      ...supportedArgs.flatMap((arg) => arg.build(versionedContext)),
    ];
    const childOptions: ChildOptions = {
      ...(await this.#getCwd(context.document)),
      ...moduleSearchEnv(context),
      cancelSignal,
      // As reading a file does, or a rule on blank lines misses `\r\n`, before djLint 1.49.1.
      input:
        mode === "lint"
          ? context.document.getText().replaceAll("\r\n", "\n")
          : context.document.getText(),
      stripFinalNewline: false,
      timeout: RUN_TIMEOUT_MS,
    };
    const { stderr, stdout } = await execa(
      command.exec,
      childArgs,
      childOptions,
    );
    this.#logWarnings(stderr);
    return stdout;
  }

  // After a configuration it cannot read, for example, djLint goes on with its defaults.
  #logWarnings(stderr: string): void {
    const warnings = stderr.trim();
    if (!warnings || this.#loggedWarnings.has(warnings)) {
      return;
    }
    this.#loggedWarnings.add(warnings);
    this.#outputChannel.warn(warnings);
  }

  async #run(
    mode: DjlintMode,
    context: ArgContext,
    token: vscode.CancellationToken,
    known?: RunnerCommand,
    isRetry = false,
  ): Promise<string> {
    const { config, document } = context;
    const command = known ?? (await this.#getCommand(document, config));
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => {
      controller.abort();
    });
    try {
      return await this.#exec(command, mode, context, controller.signal);
    } catch (e) {
      if (!isCustomExecaError(e) || e.isCanceled) {
        throw e;
      }

      const classification = await classifyRunFailure(
        e,
        (err) => isValidLintResult(err, mode === "lint"),
        isDjlintUnavailable,
        async () => probeExecutable(command.exec, command.prefixArgs, document),
      );

      if (classification === "lint-result") {
        this.#logWarnings(e.stderr);
        return e.stdout;
      }

      if (classification === "unavailable") {
        this.#resolver.invalidate();
        this.#outputChannel.debug(
          `djLint is no longer available (${e.shortMessage}).`,
        );
        if (!isRetry) {
          return await this.#run(mode, context, token, void 0, true);
        }
        throw new DjlintUnavailableError("djLint is no longer available.", {
          cause: e,
        });
      }

      return checkErrors(e, this.#outputChannel);
    } finally {
      cancellation.dispose();
    }
  }
}

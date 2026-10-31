import path from "node:path";
import process from "node:process";
import { execa } from "execa";
import * as vscode from "vscode";
import { formattingArgs, lintingArgs, type ArgContext } from "../../args.js";
import { configSection, getConfiguredPath } from "../../config.js";
import {
  normalizeConfiguredExecutable,
  workspaceScopeKey,
} from "../../paths.js";
import type {
  PythonEnvironmentDetails,
  PythonEnvironments,
} from "../../python/environment.js";
import type { DjlintStatus } from "../../status.js";
import { getExistingDocumentFolder } from "../document-folder.js";
import {
  DjlintUnavailableError,
  RUN_TIMEOUT_MS,
  type DjlintEngine,
  type DjlintMode,
  type LintDiagnostic,
} from "../types.js";
import { checkErrors, isValidLintResult } from "./errors.js";
import {
  isCustomExecaError,
  isDjlintUnavailable,
  type ChildOptions,
  type CustomExecaError,
} from "./exec.js";
import { parseLinterOutput } from "./parse-lint-output.js";
import {
  CommandResolver,
  type ProbeResult,
  type RunnerCommand,
} from "./resolve.js";
import { parseDjlintVersion, selectSupportedArgs } from "./version.js";

const PROBE_TIMEOUT_MS = 10_000;

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
      // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable name
      PYTHONPATH: [folder.uri.fsPath, ...(inherited ? [inherited] : [])].join(
        path.delimiter,
      ),
    },
  };
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

// Version managers' shims pick the Python of the folder they run from.
async function probeExecutable(
  exec: string,
  prefixArgs: readonly string[],
  document: vscode.TextDocument,
): Promise<ProbeResult> {
  const cwd = await getExistingDocumentFolder(document);
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
  readonly #loggedCommands = new Map<string, string>();
  readonly #warnedSkippedArgs = new Set<string>();
  readonly #schemesWarnedAboutCwd = new Set<string>();

  constructor(
    private readonly outputChannel: vscode.LogOutputChannel,
    private readonly pythonEnvironments: PythonEnvironments,
    private readonly status: DjlintStatus,
  ) {}

  async format(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    formattingOptions: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<string> {
    return this.#run("format", { config, document, formattingOptions }, token);
  }

  async lint(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
    token: vscode.CancellationToken,
  ): Promise<LintDiagnostic[]> {
    return parseLinterOutput(
      await this.#run("lint", { config, document }, token),
    );
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/no-empty-function
  dispose(): void {}

  async #getCommand(
    document: vscode.TextDocument,
    config: vscode.WorkspaceConfiguration,
  ): Promise<RunnerCommand> {
    const scopeKey = workspaceScopeKey(document);
    const command = await this.#resolver.resolve(
      {
        executablePath: normalizeConfiguredExecutable(
          getConfiguredPath(config, "executablePath"),
          document,
        ),
        getActiveEnvironment: config.get<boolean>("useVenv")
          ? async (uri): Promise<PythonEnvironmentDetails | null> =>
              this.pythonEnvironments.getActive(uri)
          : null,
        onConfiguredPathRejected: (setting, exec): void => {
          this.outputChannel.warn(
            `${configSection}.${setting} is set to "${exec}", but no working djLint was found there. Ignoring it and trying the next candidate.`,
          );
        },
        probe: async (exec, prefixArgs): Promise<ProbeResult> =>
          probeExecutable(exec, prefixArgs, document),
        pythonPath: normalizeConfiguredExecutable(
          getConfiguredPath(config, "pythonPath"),
          document,
        ),
        uri: document.uri,
      },
      scopeKey,
    );
    const source = [command.exec, ...command.prefixArgs].join(" ");
    this.status.update(document, command.version ?? "", source);
    const description = `djLint ${command.version ?? "of unknown version"}: ${source}`;
    if (this.#loggedCommands.get(scopeKey) !== description) {
      this.#loggedCommands.set(scopeKey, description);
      this.outputChannel.info(`Using ${description}`);
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
      this.outputChannel.warn(
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
    const supportedArgs = selectSupportedArgs(
      mode === "format" ? formattingArgs : lintingArgs,
      command.version,
      context,
      this.#warnedSkippedArgs,
      this.outputChannel,
    );
    const childArgs = [
      ...command.prefixArgs,
      "-",
      ...supportedArgs.flatMap((arg) => arg.build(context)),
    ];
    const childOptions: ChildOptions = {
      ...(await this.#getCwd(context.document)),
      ...moduleSearchEnv(context),
      cancelSignal,
      input: context.document.getText(),
      stripFinalNewline: false,
      timeout: RUN_TIMEOUT_MS,
    };
    const { stdout } = await execa(command.exec, childArgs, childOptions);
    return stdout;
  }

  async #run(
    mode: DjlintMode,
    context: ArgContext,
    token: vscode.CancellationToken,
    isRetry = false,
  ): Promise<string> {
    const { config, document } = context;
    const command = await this.#getCommand(document, config);
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
        return e.stdout;
      }

      if (classification === "unavailable") {
        this.#resolver.invalidate();
        this.outputChannel.debug(
          `djLint is no longer available (${e.shortMessage}).`,
        );
        if (!isRetry) {
          return await this.#run(mode, context, token, true);
        }
        throw new DjlintUnavailableError("djLint is no longer available.", {
          cause: e,
        });
      }

      return checkErrors(e, this.outputChannel);
    } finally {
      cancellation.dispose();
    }
  }
}

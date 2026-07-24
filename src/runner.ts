import path from "node:path";
import { execa, ExecaError } from "execa";
import * as vscode from "vscode";
import { configurationArg, rulesArg, type CliArg } from "./args.js";
import { configSection } from "./config.js";
import { DjlintUnavailableError } from "./engine/types.js";
import { checkErrors } from "./errors.js";
import {
  getEnvironmentProvider,
  resetUnavailableEnvironmentProviders,
  type EnvironmentProvider,
  type PythonEnvironmentDetails,
} from "./python/environment.js";

export interface RunnerCommand {
  exec: string;
  prefixArgs: readonly string[];
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

/** Trims a configured `djlint.executablePath`/`djlint.pythonPath` value and,
if it looks like a relative filesystem path, resolves it against the
workspace root. An empty (or whitespace-only) value comes back as `""` so
callers can treat "unset" uniformly. */
export function normalizeConfiguredExecutable(
  raw: string,
  document: vscode.TextDocument,
): string {
  const trimmed = raw.trim();
  return trimmed ? resolveConfiguredExecutablePath(trimmed, document) : trimmed;
}

/** Converts a resolved Python environment into the exec+args shape the
runner needs, appending `-m djlint` to the interpreter's own launch
command/args (which may themselves be non-empty, e.g. for conda/uv-managed
environments). Returns `null` when the environment has no runnable
command. */
function toEnvironmentRunnerCommand(
  details: PythonEnvironmentDetails | null,
): RunnerCommand | null {
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
  provider: EnvironmentProvider | null;
  uri: vscode.Uri | undefined;
  probe: (exec: string, prefixArgs: readonly string[]) => Promise<boolean>;
}

/** Pure decision: which djLint command to run. No VS Code/execa dependency
beyond the injected `deps`, so it is unit-testable in isolation.

1. `djlint.executablePath`, if non-empty, run directly — `probe()` must
   confirm it works.
2. `djlint.pythonPath`, if non-empty, run as `<pythonPath> -m djlint` —
   `probe()` must confirm that combination works too.
3. The active Python environment from `provider`, unless `djlint.useVenv` is
   explicitly `false`. The environment's own launch command/args are used
   (needed for conda/uv-managed environments) with `-m djlint` appended, and
   the result must still pass `probe()`.
4. `djlint` on PATH, if `probe()` confirms it works.
5. Otherwise `DjlintUnavailableError`, so the caller can fall back to the
   bundled runtime. */
export async function resolveDjlintCommand(
  deps: ResolveDjlintCommandDeps,
): Promise<RunnerCommand> {
  const executablePath = deps.executablePath.trim();
  if (executablePath && (await deps.probe(executablePath, []))) {
    return { exec: executablePath, prefixArgs: [] };
  }

  const pythonPath = deps.pythonPath.trim();
  if (pythonPath) {
    const prefixArgs = ["-m", "djlint"];
    if (await deps.probe(pythonPath, prefixArgs)) {
      return { exec: pythonPath, prefixArgs };
    }
  }

  if (deps.useVenv !== false && deps.provider) {
    const active = toEnvironmentRunnerCommand(
      await deps.provider.getActiveEnvironment(deps.uri),
    );
    if (active && (await deps.probe(active.exec, active.prefixArgs))) {
      return active;
    }
  }

  if (await deps.probe("djlint", [])) {
    return { exec: "djlint", prefixArgs: [] };
  }

  throw new DjlintUnavailableError(
    `Could not find djLint. Set ${configSection}.executablePath, ${configSection}.pythonPath, or install djLint so it is available on PATH.`,
  );
}

/** Cache scope for a resolved djLint command: the document's workspace
folder (stringified `vscode.Uri`), or `undefined` for the shared global
scope when the document has no workspace folder. */
export type DjlintCommandCacheKey = string | undefined;

const commandCache = new Map<DjlintCommandCacheKey, RunnerCommand>();

/** Clears every cached command resolution, forcing the next
`resolveDjlintCommandCached()` call for each scope to re-run
`resolveDjlintCommand()` (and therefore re-probe) instead of reusing a stale
result. Call whenever something that could change which djLint runs
changes: a relevant setting (`djlint.executablePath`, `djlint.pythonPath`,
`djlint.useVenv`, `djlint.importStrategy`) or the
active Python environment. Also un-latches a memoized "no Python environment
provider available" result (see `resetUnavailableEnvironmentProviders()`),
so a transient activation failure doesn't stay pinned for the rest of the
session. */
export function invalidateDjlintCommandCache(): void {
  commandCache.clear();
  resetUnavailableEnvironmentProviders();
}

/** Thin memoizing layer around `resolveDjlintCommand()`: the first
resolution for a given `scopeKey` probes/resolves as usual and, on success,
its result is cached; every later call for the same scope returns the
cached `RunnerCommand` without touching `deps.probe` or `deps.provider` at
all — this is what keeps the format/lint hot path from spawning `--version`
probes on every call. A failed resolution (`resolveDjlintCommand()`
throwing) is never cached, so installing djLint mid-session, or fixing a
broken `djlint.executablePath`, is picked up on the very next call rather
than being stuck behind a cached failure until an invalidation trigger
fires. */
export async function resolveDjlintCommandCached(
  deps: ResolveDjlintCommandDeps,
  scopeKey: DjlintCommandCacheKey,
): Promise<RunnerCommand> {
  const cached = commandCache.get(scopeKey);
  if (cached != null) {
    return cached;
  }
  const command = await resolveDjlintCommand(deps);
  commandCache.set(scopeKey, command);
  return command;
}

/** Runtime `probe`: attempts to spawn `exec [...prefixArgs, "--version"]`
and reports whether the process could be launched at all (regardless of its
exit code), which is enough to tell a missing/unresolvable executable from a
real one. `prefixArgs` lets the caller probe the exact invocation it intends
to run (e.g. `<pythonPath> -m djlint --version`), not just the bare
executable. */
async function probeExecutable(
  exec: string,
  prefixArgs: readonly string[],
): Promise<boolean> {
  try {
    const result = await execa(exec, [...prefixArgs, "--version"], {
      reject: false,
    });
    return result.exitCode !== void 0;
  } catch {
    return false;
  }
}

/** The cache scope for a document's resolved djLint command: its workspace
folder, so different folders in a multi-root workspace (which may each have
their own interpreter/virtualenv) resolve independently, or `undefined` —
the shared global scope — when the document has no workspace folder. */
function resolutionScopeKey(
  document: vscode.TextDocument,
): DjlintCommandCacheKey {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString();
}

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

  // Only activate the Python (Environments) extension when the active-environment step (guarded by useVenv) is still in play. This keeps a "djlint.executablePath only, useVenv: false" setup from paying for an extension it never asked for.
  const provider =
    useVenv === false ? null : await getEnvironmentProvider(outputChannel);

  return resolveDjlintCommandCached(
    {
      executablePath,
      probe: probeExecutable,
      provider,
      pythonPath,
      uri: document.uri,
      useVenv,
    },
    resolutionScopeKey(document),
  );
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
  env: NodeJS.ProcessEnv;
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
    // PYTHONSAFEPATH (3.11+) drops the unsafe sys.path[0] entry, so a stray djlint.py beside the document cannot shadow the real module on `-m`.
    // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable name
    env: { ...process.env, PYTHONSAFEPATH: "1" },
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
  let command;
  try {
    command = await getDjlintCommand(document, config, outputChannel);
  } catch (e) {
    // With a bundled fallback, stay quiet (log only) so the caller can switch engines instead of showing a popup for a condition that will self-resolve.
    if (hasFallback && e instanceof DjlintUnavailableError) {
      outputChannel.debug(`${e.message} Using the bundled runtime.`);
    } else {
      void vscode.window.showErrorMessage(
        // eslint-disable-next-line unicorn/prefer-error-is-error
        e instanceof Error ? e.message : String(e),
      );
    }
    throw e;
  }

  try {
    return await runDjlintCommand(
      command,
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

    return checkErrors(e, outputChannel, config, hasFallback).stdout;
  }
}

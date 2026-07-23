import path from "node:path";
import { execa, ExecaError } from "execa";
import * as vscode from "vscode";
import { configurationArg, rulesArg, type CliArg } from "./args.js";
import { configSection } from "./config.js";
import { DjlintUnavailableError } from "./engine/types.js";
import { checkErrors } from "./errors.js";
import {
  getEnvironmentProvider,
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

/** Trims a configured executable/interpreter entry and, if it looks like a
relative filesystem path, resolves it against the workspace root. Empty (or
whitespace-only) entries come back as `""` so callers can filter them out
uniformly. */
function normalizeConfiguredExecutable(
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
  path: readonly string[];
  executablePath: string | undefined;
  interpreter: readonly string[];
  useVenv: boolean | undefined;
  provider: EnvironmentProvider | null;
  uri: vscode.Uri | undefined;
  probe: (exec: string) => Promise<boolean>;
}

/** Pure decision: which djLint command to run, mirroring ruff-vscode's
`findRuffBinaryPath` resolution order. No VS Code/execa dependency beyond
the injected `deps`, so it is unit-testable in isolation.

1. `djlint.path` — the first configured executable that `probe()` confirms
   works, run directly.
2. The deprecated `djlint.executablePath`, but only when the user changed it
   from its old default (`"djlint"`) — same shape as (1).
3. `djlint.interpreter` — the first non-empty entry. If `provider` can
   resolve it to an environment, that environment's own launch command/args
   are used (with `-m djlint` appended); otherwise the entry itself is used
   as the interpreter verbatim.
4. The active Python environment from `provider`, unless the deprecated
   `djlint.useVenv` is explicitly `false`.
5. `djlint` on PATH, if `probe()` confirms it works.
6. Otherwise `DjlintUnavailableError`, so the caller can fall back to the
   bundled runtime. */
export async function resolveDjlintCommand(
  deps: ResolveDjlintCommandDeps,
): Promise<RunnerCommand> {
  for (const rawExec of deps.path) {
    const exec = rawExec.trim();
    // eslint-disable-next-line no-await-in-loop -- candidates must be probed in order; the first one that works wins.
    if (exec && (await deps.probe(exec))) {
      return { exec, prefixArgs: [] };
    }
  }

  const executablePath = deps.executablePath?.trim();
  if (
    executablePath &&
    executablePath !== "djlint" &&
    (await deps.probe(executablePath))
  ) {
    return { exec: executablePath, prefixArgs: [] };
  }

  for (const rawEntry of deps.interpreter) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    if (deps.provider) {
      const resolved = toEnvironmentRunnerCommand(
        // eslint-disable-next-line no-await-in-loop -- only the first non-empty entry is ever consulted; the loop exists solely to skip blank entries.
        await deps.provider.resolveInterpreter(entry),
      );
      if (resolved) {
        return resolved;
      }
    }
    return { exec: entry, prefixArgs: ["-m", "djlint"] };
  }

  if (deps.useVenv !== false && deps.provider) {
    const active = toEnvironmentRunnerCommand(
      await deps.provider.getActiveEnvironment(deps.uri),
    );
    if (active) {
      return active;
    }
  }

  if (await deps.probe("djlint")) {
    return { exec: "djlint", prefixArgs: [] };
  }

  throw new DjlintUnavailableError(
    `Could not find djLint. Set ${configSection}.path, ${configSection}.interpreter, or install djLint so it is available on PATH.`,
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
changes: a relevant setting (`djlint.path`, `djlint.interpreter`,
`djlint.executablePath`, `djlint.useVenv`, `djlint.importStrategy`) or the
active Python environment. */
export function invalidateDjlintCommandCache(): void {
  commandCache.clear();
}

/** Thin memoizing layer around `resolveDjlintCommand()`: the first
resolution for a given `scopeKey` probes/resolves as usual and, on success,
its result is cached; every later call for the same scope returns the
cached `RunnerCommand` without touching `deps.probe` or `deps.provider` at
all — this is what keeps the format/lint hot path from spawning `--version`
probes on every call. A failed resolution (`resolveDjlintCommand()`
throwing) is never cached, so installing djLint mid-session, or fixing a
broken `djlint.path`, is picked up on the very next call rather than being
stuck behind a cached failure until an invalidation trigger fires. */
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

/** Runtime `probe`: attempts to spawn `exec --version` and reports whether
the process could be launched at all (regardless of its exit code), which is
enough to tell a missing/unresolvable executable from a real one. */
async function probeExecutable(exec: string): Promise<boolean> {
  try {
    const result = await execa(exec, ["--version"], { reject: false });
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

  const rawExecutablePath = config.get<string>("executablePath");
  const interpreter = (config.get<string[]>("interpreter") ?? []).map((raw) =>
    normalize(raw),
  );
  const useVenv = config.get<boolean>("useVenv");

  // Only activate the Python (Environments) extension when this resolution could actually use it: either djlint.interpreter has an entry to resolve, or the active environment step (guarded by the deprecated useVenv) is still in play. This keeps a "djlint.path only, useVenv: false" setup from paying for an extension it never asked for.
  const requiresProvider =
    interpreter.some((entry) => entry !== "") || useVenv !== false;
  const provider = requiresProvider
    ? await getEnvironmentProvider(outputChannel)
    : null;

  return resolveDjlintCommandCached(
    {
      executablePath:
        rawExecutablePath == null ? void 0 : normalize(rawExecutablePath),
      interpreter,
      path: (config.get<string[]>("path") ?? []).map((raw) => normalize(raw)),
      probe: probeExecutable,
      provider,
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

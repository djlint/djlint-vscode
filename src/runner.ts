import path from "node:path";
import { execa, ExecaError } from "execa";
import * as vscode from "vscode";
import { configurationArg, rulesArg, type CliArg } from "./args.js";
import { configSection } from "./config.js";
import { RESOLUTION_TTL_MS } from "./engine/subprocess/constants.js";
import { isDjlintUnavailable } from "./engine/subprocess/unavailable.js";
import { DjlintUnavailableError } from "./engine/types.js";
import { checkErrors, isValidLintResult } from "./errors.js";
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

/** A resolved djLint invocation plus the version its `--version` probe
reported, used to gate which `CliArg`s `runDjlintCommand()` may send it. */
export interface RunnerCommand {
  exec: string;
  prefixArgs: readonly string[];
  version: string;
}

/** A `RunnerCommand` before it has been paired with a probed version. */
type RunnerTarget = Omit<RunnerCommand, "version">;

/** Bounds `probeExecutable()`'s `--version` spawn so an unresponsive
candidate (a stdin-waiting wrapper, a stalled network/conda/uv mount) fails
the probe like any other unusable candidate instead of hanging command
resolution -- and, via `classifyRunFailure()`'s `reprobe`, a live
format/lint call too. */
const PROBE_TIMEOUT_MS = 10_000;

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

/** Trims a configured `djlint.executablePath`/`djlint.pythonPath` value and
resolves it against the workspace root if it looks like a relative path.
Empty/whitespace-only input comes back as `""` ("unset"). */
export function normalizeConfiguredExecutable(
  raw: string,
  document: vscode.TextDocument,
): string {
  const trimmed = raw.trim();
  return trimmed ? resolveConfiguredExecutablePath(trimmed, document) : trimmed;
}

/** Converts a resolved Python environment into a runner target, appending
`-m djlint` to the interpreter's own launch command/args (non-empty for
conda/uv-managed environments). `null` when there's no runnable command. */
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
  /** Resolves the active Python environment, or `null` when
  `djlint.useVenv` is `false`. A lazy function, not a resolved value, so it's
  only invoked when resolution actually reaches this step (never on a cache
  hit or when `executablePath`/`pythonPath` already won). */
  getActiveEnvironment:
    | ((
        uri: vscode.Uri | undefined,
      ) => Promise<PythonEnvironmentDetails | null>)
    | null;
  uri: vscode.Uri | undefined;
  /** Validates `<exec> [...prefixArgs, "--version"]`: returns the parsed
  version on a `0` exit with recognizable output, `null` otherwise (not
  found, non-zero exit, or a valid interpreter with no djLint installed). */
  probe: (
    exec: string,
    prefixArgs: readonly string[],
  ) => Promise<string | null>;
}

/** Pure decision: which djLint command to run. No VS Code/execa dependency
beyond the injected `deps`, so it is unit-testable in isolation.

Tries, in order: `executablePath`, `pythonPath` (as `-m djlint`), the active
Python environment (unless `useVenv` is `false`), then `djlint` on PATH.
Each candidate must pass `probe()` (return a version, not just launch) to be
accepted — an interpreter with no djLint installed falls through to the next
candidate instead of failing later at run time. Throws
`DjlintUnavailableError` if none work. */
export async function resolveDjlintCommand(
  deps: ResolveDjlintCommandDeps,
): Promise<RunnerCommand> {
  const executablePath = deps.executablePath.trim();
  if (executablePath) {
    const version = await deps.probe(executablePath, []);
    if (version != null) {
      return { exec: executablePath, prefixArgs: [], version };
    }
  }

  const pythonPath = deps.pythonPath.trim();
  if (pythonPath) {
    const prefixArgs = ["-m", "djlint"];
    const version = await deps.probe(pythonPath, prefixArgs);
    if (version != null) {
      return { exec: pythonPath, prefixArgs, version };
    }
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

/** Cache scope for a resolved djLint command: the document's workspace
folder (stringified `vscode.Uri`), or `undefined` for the shared scope. */
export type DjlintCommandCacheKey = string | undefined;

interface CommandCacheEntry {
  command: RunnerCommand;
  resolvedAt: number;
}

const commandCache = new Map<DjlintCommandCacheKey, CommandCacheEntry>();

/** In-flight `resolveDjlintCommand()` calls, keyed by scope, so concurrent
callers on an empty/expired cache (format+lint firing together on save)
share one resolution instead of each running up to four sequential
`--version` spawns. Entries are removed once the resolution settles, so a
failure is retried -- not latched -- on the next call. */
const inFlightResolutions = new Map<
  DjlintCommandCacheKey,
  Promise<RunnerCommand>
>();

// Bumped by invalidateDjlintCommandCache(); a resolution captures it before awaiting and skips its cache write if it changed, so an invalidation landing mid-flight can't be undone by a stale write. Held on an object (not a top-level `let`) so it can be mutated from inside a function.
const cacheEpoch = { value: 0 };

/** Clears every cached command resolution, un-latches a memoized "Python
extension unavailable" result, and clears the skipped-arg warning dedupe.
Call whenever something that could change which djLint runs changes; also
run by `djlint.restart` as a manual escape hatch. */
export function invalidateDjlintCommandCache(): void {
  // Bump first: clear() can't cancel a resolution already awaiting inside resolveDjlintCommandCached, but the epoch change makes it skip its now-stale cache write instead of repopulating for a full TTL.
  cacheEpoch.value += 1;
  commandCache.clear();
  // So `djlint.restart` can't latch onto a resolution that started before it was invoked.
  inFlightResolutions.clear();
  resetSkippedArgWarnings();
  resetPythonEnvironmentProviderIfUnavailable();
}

/** Thin memoizing layer around `resolveDjlintCommand()`: caches a successful
resolution per `scopeKey` for `RESOLUTION_TTL_MS`, keeping the format/lint
hot path from re-probing every call. A failed resolution is never cached,
so a fix (e.g. installing djLint) is picked up on the very next call.
Concurrent callers for the same `scopeKey` share a single in-flight
resolution rather than each starting their own. */
export async function resolveDjlintCommandCached(
  deps: ResolveDjlintCommandDeps,
  scopeKey: DjlintCommandCacheKey,
): Promise<RunnerCommand> {
  const cached = commandCache.get(scopeKey);
  if (cached != null && Date.now() - cached.resolvedAt < RESOLUTION_TTL_MS) {
    return cached.command;
  }

  const pending =
    inFlightResolutions.get(scopeKey) ??
    (async (): Promise<RunnerCommand> => {
      const epoch = cacheEpoch.value;
      const command = await resolveDjlintCommand(deps);
      // Skip the write if the cache was invalidated while resolving: the result is stale and would otherwise survive a full TTL. The caller still gets this command; only the cache poisoning is prevented.
      if (epoch === cacheEpoch.value) {
        commandCache.set(scopeKey, { command, resolvedAt: Date.now() });
      }
      return command;
    })();
  inFlightResolutions.set(scopeKey, pending);
  try {
    return await pending;
  } finally {
    // Every concurrent caller shares the same `pending` promise, so this fires once it settles regardless of which caller's `finally` runs first; a later caller that starts a new resolution after that point isn't affected.
    inFlightResolutions.delete(scopeKey);
  }
}

/** Runtime `probe`: runs `<exec> [...prefixArgs, "--version"]` and requires
both a `0` exit code and stdout that parses as a djLint version — an
interpreter that launches but has no djLint installed correctly fails
instead of being accepted and only failing at run time. */
async function probeExecutable(
  exec: string,
  prefixArgs: readonly string[],
): Promise<string | null> {
  try {
    const result = await execa(exec, [...prefixArgs, "--version"], {
      // Match runDjlintCommand()'s env so the probed module is the one that will actually run.
      // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable name
      env: { ...process.env, PYTHONSAFEPATH: "1" },
      reject: false,
      // A candidate that never exits (stdin-waiting wrapper, unresponsive mount) must fail the probe like any other unusable candidate rather than hanging the format/lint call that triggered resolution.
      stdin: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });
    return result.exitCode === 0 ? parseDjlintVersion(result.stdout) : null;
  } catch {
    return null;
  }
}

/** The cache scope for a document's resolved djLint command: its workspace
folder (so multi-root folders resolve independently), or `undefined` for
the shared global scope. */
function resolutionScopeKey(
  document: vscode.TextDocument,
): DjlintCommandCacheKey {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString();
}

async function getDjlintCommand(
  document: vscode.TextDocument,
  config: vscode.WorkspaceConfiguration,
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
      // Lazy reference, not an awaited call, so an executablePath-only setup or a warm cache hit never pays to activate the Python extension.
      getActiveEnvironment:
        useVenv === false
          ? null
          : async (uri): Promise<PythonEnvironmentDetails | null> =>
              getActivePythonEnvironment(uri),
      probe: probeExecutable,
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

function isCustomExecaError(e: unknown): e is CustomExecaError {
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
  const supportedArgs = selectSupportedArgs(
    args,
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

/** What `runDjlint()`'s catch should do with a genuine (post-resolution)
djLint invocation failure. */
export type RunFailureClassification = "error" | "lint-result" | "unavailable";

/** Pure decision for a failed djLint invocation: valid lint result, djLint
now unavailable, or a genuine error? No VS Code/execa dependency beyond the
injected functions, so it is unit-testable in isolation.

Order matters: `isValidResult(e)` is checked first, before any re-probe,
since a lint-findings exit is the common case. `isUnavailableFast(e)` is the
cheap ENOENT/"No module named" shortcut. Only then does `reprobe()` run, as
the cross-platform backstop — Windows reports a missing executable as a
localized non-zero exit rather than `ENOENT`, so the fast check alone misses
it there; re-running the same `--version` probe is locale-independent. This
step is rare, not on the hot path. */
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
  args: readonly CliArg[],
  outputChannel: vscode.LogOutputChannel,
  abortController: AbortController,
  /** Whether this is a lint request (as opposed to a format request):
  gates `isValidLintResult()` so a formatter's non-zero exit is never
  mistaken for valid (if empty/garbage) formatted output. */
  isLint: boolean,
  formattingOptions?: vscode.FormattingOptions,
): Promise<string> {
  let command;
  try {
    command = await getDjlintCommand(document, config);
  } catch (e) {
    // Log only, no popup: lets FallbackEngine switch to the bundled runtime for a condition that will self-resolve.
    if (e instanceof DjlintUnavailableError) {
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
    // A cancelled run (superseded/aborted) has no usable result: skip the wasted --version reprobe, and don't let a transient probe miss misread the cancellation as "djLint unavailable". The token-cancelled caller ignores this throw.
    if (e.isCanceled) {
      throw e;
    }

    const classification = await classifyRunFailure(
      e,
      (err) => isValidLintResult(err, isLint),
      isDjlintUnavailable,
      async () => probeExecutable(command.exec, command.prefixArgs),
    );

    if (classification === "lint-result") {
      return e.stdout;
    }

    if (classification === "unavailable") {
      // `djlint` resolved earlier but is gone now (uninstalled, venv rebuilt, etc). Drop the cache so the next call re-resolves instead of reusing it for up to RESOLUTION_TTL_MS; log only, no popup.
      invalidateDjlintCommandCache();
      outputChannel.debug(
        `External djLint not available (${e.shortMessage}); using the bundled runtime.`,
      );
      throw new DjlintUnavailableError("External djLint is not available.", {
        cause: e,
      });
    }

    return checkErrors(e, outputChannel).stdout;
  }
}

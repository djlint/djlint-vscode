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
import { isVersionAtLeast, parseDjlintVersion } from "./version.js";

/** A resolved djLint invocation, plus the version that resolution proved it
to be (via a successful `--version` probe) — used to gate which `CliArg`s
`runDjlintCommand()` is allowed to send it (see `selectSupportedArgs()`). */
export interface RunnerCommand {
  exec: string;
  prefixArgs: readonly string[];
  version: string;
}

/** A resolved djLint invocation, without the version — the shape
`resolveDjlintCommand()`'s individual candidate steps build before pairing it
with whatever version its `probe()` call reported. */
type RunnerTarget = Omit<RunnerCommand, "version">;

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
  provider: EnvironmentProvider | null;
  uri: vscode.Uri | undefined;
  /** Validates a candidate invocation by running
  `<exec> [...prefixArgs, "--version"]`: returns the parsed
  `major.minor[.patch]` version string when it exits `0` and prints a
  recognizable version, or `null` when the candidate is unusable (not found,
  non-zero exit, or unparseable output — e.g. a valid interpreter with no
  djLint installed). */
  probe: (
    exec: string,
    prefixArgs: readonly string[],
  ) => Promise<string | null>;
}

/** Pure decision: which djLint command to run. No VS Code/execa dependency
beyond the injected `deps`, so it is unit-testable in isolation.

1. `djlint.executablePath`, if non-empty, run directly — `probe()` must
   confirm it works and report its version.
2. `djlint.pythonPath`, if non-empty, run as `<pythonPath> -m djlint` —
   `probe()` must confirm that combination works too.
3. The active Python environment from `provider`, unless `djlint.useVenv` is
   explicitly `false`. The environment's own launch command/args are used
   (needed for conda/uv-managed environments) with `-m djlint` appended, and
   the result must still pass `probe()`.
4. `djlint` on PATH, if `probe()` confirms it works.
5. Otherwise `DjlintUnavailableError`, so the caller can fall back to the
   bundled runtime.

Each candidate is accepted only when `probe()` returns a version (not just a
launchable process) — a `pythonPath`/active-environment interpreter that
launches fine but has no djLint installed now correctly falls through to the
next candidate instead of being accepted and only failing at run time. */
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

  if (deps.useVenv !== false && deps.provider) {
    const active = toEnvironmentRunnerCommand(
      await deps.provider.getActiveEnvironment(deps.uri),
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
folder (stringified `vscode.Uri`), or `undefined` for the shared global
scope when the document has no workspace folder. */
export type DjlintCommandCacheKey = string | undefined;

/** How long a resolved `{ command, version }` stays cached before it is
treated as stale and re-resolved (re-running `--version`), even without any
of the explicit invalidation triggers firing. This is what picks up an
in-place upgrade (e.g. `pip install -U djlint`) without the user touching a
setting or the active Python environment — the two things that DO invalidate
the cache immediately via `invalidateDjlintCommandCache()`. 5 minutes
balances that against re-probing (spawning a process) on every
format/lint call. */
export const RESOLUTION_TTL_MS = 5 * 60 * 1000;

interface CommandCacheEntry {
  command: RunnerCommand;
  resolvedAt: number;
}

const commandCache = new Map<DjlintCommandCacheKey, CommandCacheEntry>();

/** Clears every cached command resolution, forcing the next
`resolveDjlintCommandCached()` call for each scope to re-run
`resolveDjlintCommand()` (and therefore re-probe) instead of reusing a stale
result. Call whenever something that could change which djLint runs
changes: a relevant setting (`djlint.executablePath`, `djlint.pythonPath`,
`djlint.useVenv`, `djlint.importStrategy`) or the
active Python environment. Also un-latches a memoized "no Python environment
provider available" result (see `resetUnavailableEnvironmentProviders()`),
so a transient activation failure doesn't stay pinned for the rest of the
session. This is also what the `djlint.restart` command runs (via
`invalidateResolution()` in `extension.ts`) as a manual escape hatch — e.g.
right after an in-place djLint upgrade, rather than waiting out
`RESOLUTION_TTL_MS`. */
export function invalidateDjlintCommandCache(): void {
  commandCache.clear();
  resetUnavailableEnvironmentProviders();
}

/** Thin memoizing layer around `resolveDjlintCommand()`: the first
resolution for a given `scopeKey` probes/resolves as usual and, on success,
its result is cached (with the resolution time); every later call for the
same scope returns the cached `RunnerCommand` — without touching
`deps.probe` or `deps.provider` at all — as long as it is younger than
`RESOLUTION_TTL_MS`. This is what keeps the format/lint hot path from
spawning `--version` probes on every call, while still picking up an
in-place djLint upgrade within a few minutes on its own (see
`RESOLUTION_TTL_MS`) even if nothing explicitly invalidates the cache. A
failed resolution (`resolveDjlintCommand()` throwing) is never cached, so
installing djLint mid-session, or fixing a broken `djlint.executablePath`,
is picked up on the very next call rather than being stuck behind a cached
failure until an invalidation trigger fires or the TTL expires. */
export async function resolveDjlintCommandCached(
  deps: ResolveDjlintCommandDeps,
  scopeKey: DjlintCommandCacheKey,
): Promise<RunnerCommand> {
  const cached = commandCache.get(scopeKey);
  if (cached != null && Date.now() - cached.resolvedAt < RESOLUTION_TTL_MS) {
    return cached.command;
  }
  const command = await resolveDjlintCommand(deps);
  commandCache.set(scopeKey, { command, resolvedAt: Date.now() });
  return command;
}

/** Runtime `probe`: validates a candidate `<exec> [...prefixArgs]`
invocation by running `[...prefixArgs, "--version"]` and requires BOTH a
`0` exit code AND stdout that parses as a djLint version (see
`parseDjlintVersion()`) — a valid interpreter/executable that merely
launches but has no djLint installed (or isn't djLint at all) now correctly
fails the probe instead of being accepted and only failing at run time.
Returns the parsed version string on success, `null` otherwise. `prefixArgs`
lets the caller probe the exact invocation it intends to run (e.g.
`<pythonPath> -m djlint --version`), not just the bare executable. */
async function probeExecutable(
  exec: string,
  prefixArgs: readonly string[],
): Promise<string | null> {
  try {
    const result = await execa(exec, [...prefixArgs, "--version"], {
      reject: false,
    });
    return result.exitCode === 0 ? parseDjlintVersion(result.stdout) : null;
  } catch {
    return null;
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

/** Filters `args` down to the ones `version` actually supports (i.e.
`isVersionAtLeast(version, arg.minVersion)`), logging one
`outputChannel.warn()` per skipped arg naming the option and the required
`minVersion`. Pure aside from the logging side effect, so it is
unit-testable with a fake `outputChannel` and no real `CliArg`/execa
involved. This is what keeps a djLint older than, say,
`STDIN_FILENAME_MIN_VERSION` from ever being sent `--stdin-filename` (or any
other option newer than its own version) — `errors.ts`'s "No such option"
handling remains as a safety net for anything this filter misses (e.g. an
option removed in a newer djLint than the one djlint-vscode targets). */
export function selectSupportedArgs(
  args: readonly CliArg[],
  version: string,
  outputChannel: vscode.LogOutputChannel,
): readonly CliArg[] {
  return args.filter((arg) => {
    if (isVersionAtLeast(version, arg.minVersion)) {
      return true;
    }
    const optionName = arg.vscodeName
      ? `djlint.${arg.vscodeName}`
      : arg.cliName;
    outputChannel.warn(
      `Skipping ${optionName} (${arg.cliName}): requires djLint >= ${arg.minVersion}, resolved djLint is ${version}.`,
    );
    return false;
  });
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

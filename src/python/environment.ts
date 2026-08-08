import { isDeepStrictEqual } from "node:util";
import {
  EXTENSION_ID as pythonEnvironmentsExtensionId,
  type PythonEnvironment,
  type PythonEnvironmentApi,
} from "@vscode/python-environments";
import {
  PythonExtension as PythonExtensionApi,
  PVSC_EXTENSION_ID as pythonExtensionId,
  type ResolvedEnvironment,
} from "@vscode/python-extension";
import * as vscode from "vscode";

export interface PythonCommand {
  args: readonly string[];
  executable: string;
}

export interface PythonEnvironmentDetails {
  command: PythonCommand | null;
}

/** One of the two extensions that can report the active Python environment.
Exactly one is chosen per session by `activateEnvironmentProvider()`; there
is no per-call fallback between them. */
interface EnvironmentProvider {
  getActiveEnvironment: (
    uri: vscode.Uri | undefined,
  ) => Promise<PythonEnvironmentDetails | null>;
}

const activePythonEnvironmentChangeEmitter = new vscode.EventEmitter<void>();

/** Fired when the active Python interpreter for some scope changes, so
callers can invalidate anything cached against it. No payload: the only
subscriber invalidates unconditionally regardless of scope. */
export const onDidChangeActivePythonEnvironment: vscode.Event<void> =
  activePythonEnvironmentChangeEmitter.event;

const unavailable = Symbol("unavailable");

/** Disposables from activating whichever Python extension won selection
(its active-environment-changed listener). Bridged into the caller's
`vscode.Disposable[]` by `initializePythonEnvironment()` so it's cleaned up
on deactivate instead of leaking. */
const providerDisposables: vscode.Disposable[] = [];

function disposeProviderDisposables(): void {
  for (const disposable of providerDisposables) {
    disposable.dispose();
  }
  providerDisposables.length = 0;
}

/** Key for a `getActiveEnvironment()` scope: the stringified `Uri`, or `""`
for the workspace-wide scope (a stringified `Uri` is never empty). */
function environmentScopeKey(uri: vscode.Uri | undefined): string {
  return uri?.toString() ?? "";
}

function toPythonEnvironmentsDetails(
  environment: PythonEnvironment | undefined,
): PythonEnvironmentDetails | null {
  // An environment the extension itself flagged as broken has no usable interpreter; treat it as "nothing active" so resolution moves on to `djlint` on PATH.
  if (environment == null || environment.error) {
    return null;
  }
  const { run } = environment.execInfo;
  return { command: { args: run.args ?? [], executable: run.executable } };
}

/** Builds the provider backed by the Python Environments extension and
registers its change listener. */
function createPythonEnvironmentsProvider(
  api: PythonEnvironmentApi,
  outputChannel: vscode.LogOutputChannel | undefined,
): EnvironmentProvider {
  // The extension re-fires onDidChangeEnvironment for environments that did not actually change, so remember the last command seen per scope and forward only real changes: each forwarded event costs a full djLint command re-resolution (up to four --version spawns) plus a re-lint of every open document.
  const lastSeen = new Map<string, PythonEnvironmentDetails | null>();

  /** Whether `details` differs from what was last stored for the scope. An
  unseen scope counts as changed, since nothing is known about what came
  before it. */
  function hasScopeChanged(
    uri: vscode.Uri | undefined,
    details: PythonEnvironmentDetails | null,
  ): boolean {
    return !isDeepStrictEqual(lastSeen.get(environmentScopeKey(uri)), details);
  }

  function rememberScope(
    uri: vscode.Uri | undefined,
    details: PythonEnvironmentDetails | null,
  ): void {
    lastSeen.set(environmentScopeKey(uri), details);
  }

  providerDisposables.push(
    api.onDidChangeEnvironment((event) => {
      const details = toPythonEnvironmentsDetails(event.new);
      const previous = toPythonEnvironmentsDetails(event.old);
      const isChanged = hasScopeChanged(event.uri, details);
      // Remember unconditionally, even when the event is dropped below, so the next event is compared against what the extension last reported rather than a stale entry.
      rememberScope(event.uri, details);
      if (!isChanged || isDeepStrictEqual(previous, details)) {
        outputChannel?.debug(
          `Ignoring a Python Environments change event for "${event.uri?.toString() ?? "workspace"}": the active environment is unchanged.`,
        );
        return;
      }
      activePythonEnvironmentChangeEmitter.fire();
    }),
  );

  async function getActiveEnvironment(
    uri: vscode.Uri | undefined,
  ): Promise<PythonEnvironmentDetails | null> {
    const environment = await api.getEnvironment(uri);
    if (environment?.error) {
      outputChannel?.warn(
        `Ignoring the Python environment at "${environment.environmentPath.toString()}": ${environment.error}`,
      );
    }
    const details = toPythonEnvironmentsDetails(environment);
    rememberScope(uri, details);
    return details;
  }

  return { getActiveEnvironment };
}

/** Activates the Python Environments extension
(`ms-python.vscode-python-envs`), the preferred provider. Never throws:
not installed, failed to activate, or switched off through
`python.useEnvironmentsExtension` (in which case it exports no API and the
classic Python extension is the one in charge) all resolve to `null` so
selection falls through to `activateClassicPythonExtension()`. */
async function activatePythonEnvironmentsExtension(
  outputChannel: vscode.LogOutputChannel | undefined,
): Promise<EnvironmentProvider | null> {
  const extension = vscode.extensions.getExtension<
    PythonEnvironmentApi | undefined
  >(pythonEnvironmentsExtensionId);
  if (extension == null) {
    outputChannel?.info(
      "The Python Environments extension is not installed or is disabled.",
    );
    return null;
  }

  outputChannel?.info("Initializing the Python Environments extension");
  let api;
  try {
    api = extension.isActive ? extension.exports : await extension.activate();
  } catch (e) {
    outputChannel?.warn(
      `The Python Environments extension failed to activate: ${String(e)}`,
    );
    return null;
  }

  if (api == null) {
    outputChannel?.info(
      "The Python Environments extension exports no API; it is disabled by python.useEnvironmentsExtension.",
    );
    return null;
  }

  outputChannel?.info(
    "Using the Python Environments extension for Python environment detection",
  );
  return createPythonEnvironmentsProvider(api, outputChannel);
}

function toClassicEnvironmentDetails(
  environment: ResolvedEnvironment,
): PythonEnvironmentDetails {
  const executable = environment.executable.uri?.fsPath;
  return { command: executable == null ? null : { args: [], executable } };
}

/** Builds the provider backed by the classic Python extension and registers
its change listener. */
function createClassicPythonProvider(
  api: PythonExtensionApi,
): EnvironmentProvider {
  providerDisposables.push(
    api.environments.onDidChangeActiveEnvironmentPath(() => {
      activePythonEnvironmentChangeEmitter.fire();
    }),
  );

  async function getActiveEnvironment(
    uri: vscode.Uri | undefined,
  ): Promise<PythonEnvironmentDetails | null> {
    const environment = await api.environments.resolveEnvironment(
      api.environments.getActiveEnvironmentPath(uri),
    );
    return environment == null
      ? null
      : toClassicEnvironmentDetails(environment);
  }

  return { getActiveEnvironment };
}

/** Activates the classic Python extension (`ms-python.python`), the
fallback provider. Never throws: a missing, disabled, or failed activation
resolves to `null` instead, since djLint falls back to its bundled runtime
whenever this integration isn't available. */
async function activateClassicPythonExtension(
  outputChannel: vscode.LogOutputChannel | undefined,
): Promise<EnvironmentProvider | null> {
  // PythonExtensionApi.api() rejects when the extension is absent; checking first keeps that ordinary case out of the warning path.
  if (vscode.extensions.getExtension(pythonExtensionId) == null) {
    outputChannel?.info(
      "The Python extension is not installed or is disabled.",
    );
    return null;
  }

  outputChannel?.info("Initializing the Python extension");
  try {
    const provider = createClassicPythonProvider(
      await PythonExtensionApi.api(),
    );
    outputChannel?.info(
      "Using the Python extension for Python environment detection",
    );
    return provider;
  } catch (e) {
    outputChannel?.warn(`The Python extension is not available: ${String(e)}`);
    return null;
  }
}

/** Picks this session's environment provider: the Python Environments
extension when it is installed and enabled, otherwise the classic Python
extension. `unavailable` means neither is usable, which is not an error —
resolution then falls through to `djlint` on PATH and, failing that, the
bundled runtime. */
async function activateEnvironmentProvider(
  outputChannel: vscode.LogOutputChannel | undefined,
): Promise<EnvironmentProvider | typeof unavailable> {
  const provider =
    (await activatePythonEnvironmentsExtension(outputChannel)) ??
    (await activateClassicPythonExtension(outputChannel));
  return provider ?? unavailable;
}

/** Memoizes `activateEnvironmentProvider()`: `pending` is stashed
synchronously so concurrent callers share one activation attempt instead of
racing. An `unavailable` outcome is cached in `lastResult` too, until
`resetPythonEnvironmentProviderIfUnavailable()` clears it for a retry; a
successful activation is never reset, so its listener is registered once. */
const activation: {
  lastResult: EnvironmentProvider | typeof unavailable | undefined;
  pending: Promise<EnvironmentProvider | typeof unavailable> | undefined;
} = { lastResult: void 0, pending: void 0 };

async function getEnvironmentProvider(
  outputChannel?: vscode.LogOutputChannel,
): Promise<EnvironmentProvider | null> {
  activation.pending ??= activateEnvironmentProvider(outputChannel);
  const result = await activation.pending;
  // eslint-disable-next-line require-atomic-updates -- concurrent callers share the same pending promise and redundantly write the same result; not a real race.
  activation.lastResult = result;
  return result === unavailable ? null : result;
}

/** Holds the output channel to log through once a Python extension actually
activates, stashed by `initializePythonEnvironment()` for
`getActivePythonEnvironment()`'s later lazy call. `undefined` until that
runs. */
const pythonEnvironmentInit: {
  outputChannel: vscode.LogOutputChannel | undefined;
} = { outputChannel: void 0 };

/** Registers the disposal bridge for the eventual activation of whichever
Python extension is selected, and stashes `outputChannel` for later logging.
Deliberately does NOT activate either extension itself: activation stays
lazy, so a user on `executablePath`/`useVenv: false` never pays for an
extension they never asked for. Call once, early in `activate()`; calling
again is harmless. */
export function initializePythonEnvironment(
  disposables: vscode.Disposable[],
  outputChannel?: vscode.LogOutputChannel,
): void {
  disposables.push({ dispose: disposeProviderDisposables });
  pythonEnvironmentInit.outputChannel = outputChannel;
}

/** Resolves the active Python environment for a file, folder, or workspace,
via the Python Environments extension or, failing that, the classic Python
extension. Never throws: it returns `null` when neither is available,
including when one throws internally, so a misbehaving Python extension
can't break the resolution/fallback chain in `runner.ts`. Also where the
selected extension actually activates for the first time in a session
(lazily, via `getEnvironmentProvider()`). */
export async function getActivePythonEnvironment(
  uri?: vscode.Uri,
): Promise<PythonEnvironmentDetails | null> {
  const provider = await getEnvironmentProvider(
    pythonEnvironmentInit.outputChannel,
  );
  if (provider == null) {
    return null;
  }
  try {
    return await provider.getActiveEnvironment(uri);
  } catch {
    return null;
  }
}

/** Un-latches a previously memoized "no Python extension available"
outcome, so the next `getActivePythonEnvironment()` call retries activation
instead of staying pinned to a transient failure (e.g. the extension still
installing). A successfully-activated provider is left untouched. Safe to
call unconditionally; wired into `invalidateDjlintCommandCache()`. */
export function resetPythonEnvironmentProviderIfUnavailable(): void {
  if (activation.lastResult !== unavailable) {
    return;
  }
  activation.pending = void 0;
  activation.lastResult = void 0;
}

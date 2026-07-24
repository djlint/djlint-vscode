import {
  PythonExtension as PythonExtensionApi,
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

const activePythonEnvironmentChangeEmitter = new vscode.EventEmitter<void>();

/** Fired when the active Python interpreter for some scope changes, so
callers can invalidate anything cached against it. No payload: the only
subscriber invalidates unconditionally regardless of scope. */
export const onDidChangeActivePythonEnvironment: vscode.Event<void> =
  activePythonEnvironmentChangeEmitter.event;

const unavailable = Symbol("unavailable");

/** Disposables from activating the classic Python extension's environment
API (its `onDidChangeActiveEnvironmentPath` listener). Bridged into the
caller's `vscode.Disposable[]` by `initializePythonEnvironment()` so it's
cleaned up on deactivate instead of leaking. */
const providerDisposables: vscode.Disposable[] = [];

function disposeProviderDisposables(): void {
  for (const disposable of providerDisposables) {
    disposable.dispose();
  }
  providerDisposables.length = 0;
}

/** Activates the classic Python extension (`ms-python.python`), registering
its active-environment-changed listener. Never throws: a missing, disabled,
or failed activation resolves to `unavailable` instead, since djLint falls
back to its bundled runtime whenever this integration isn't available. */
async function activateClassicPythonExtension(
  outputChannel: vscode.LogOutputChannel | undefined,
): Promise<PythonExtensionApi | typeof unavailable> {
  outputChannel?.info("Initializing the Python extension");
  try {
    const api = await PythonExtensionApi.api();
    providerDisposables.push(
      api.environments.onDidChangeActiveEnvironmentPath(() => {
        activePythonEnvironmentChangeEmitter.fire();
      }),
    );
    outputChannel?.info(
      "Using the Python extension for Python environment detection",
    );
    return api;
  } catch (e) {
    outputChannel?.warn(`The Python extension is not available: ${String(e)}`);
    return unavailable;
  }
}

/** Memoizes `activateClassicPythonExtension()`: `pending` is stashed
synchronously so concurrent callers share one activation attempt instead of
racing. An `unavailable` outcome is cached in `lastResult` too, until
`resetPythonEnvironmentProviderIfUnavailable()` clears it for a retry; a
successful activation is never reset, so its listener is registered once. */
const activation: {
  pending: Promise<PythonExtensionApi | typeof unavailable> | undefined;
  lastResult: PythonExtensionApi | typeof unavailable | undefined;
} = { lastResult: void 0, pending: void 0 };

async function getClassicPythonExtension(
  outputChannel?: vscode.LogOutputChannel,
): Promise<PythonExtensionApi | null> {
  activation.pending ??= activateClassicPythonExtension(outputChannel);
  const result = await activation.pending;
  // eslint-disable-next-line require-atomic-updates -- concurrent callers share the same pending promise and redundantly write the same result; not a real race.
  activation.lastResult = result;
  return result === unavailable ? null : result;
}

/** Holds the output channel to log through once the classic Python
extension actually activates, stashed by `initializePythonEnvironment()`
for `getActivePythonEnvironment()`'s later lazy call. `undefined` until
that runs. */
const pythonEnvironmentInit: {
  outputChannel: vscode.LogOutputChannel | undefined;
} = { outputChannel: void 0 };

/** Registers the disposal bridge for the classic Python extension's
eventual activation, and stashes `outputChannel` for later logging.
Deliberately does NOT activate `ms-python.python` itself: activation stays
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

function toClassicEnvironmentDetails(
  environment: ResolvedEnvironment,
): PythonEnvironmentDetails {
  const executable = environment.executable.uri?.fsPath;
  return { command: executable == null ? null : { args: [], executable } };
}

/** Resolves the active Python environment for a file, folder, or workspace,
via the classic Python extension. Never throws — returns `null` when the
extension is unavailable, including when it throws internally, so a
misbehaving Python extension can't break the resolution/fallback chain in
`runner.ts`. Also where the extension actually activates for the first time
in a session (lazily, via `getClassicPythonExtension()`). */
export async function getActivePythonEnvironment(
  uri?: vscode.Uri,
): Promise<PythonEnvironmentDetails | null> {
  const api = await getClassicPythonExtension(
    pythonEnvironmentInit.outputChannel,
  );
  if (api == null) {
    return null;
  }
  try {
    const environment = await api.environments.resolveEnvironment(
      api.environments.getActiveEnvironmentPath(uri),
    );
    return environment == null
      ? null
      : toClassicEnvironmentDetails(environment);
  } catch {
    return null;
  }
}

/** Un-latches a previously memoized "Python extension unavailable" outcome,
so the next `getActivePythonEnvironment()` call retries activation instead
of staying pinned to a transient failure (e.g. the extension still
installing). A successfully-activated extension is left untouched. Safe to
call unconditionally; wired into `invalidateDjlintCommandCache()`. */
export function resetPythonEnvironmentProviderIfUnavailable(): void {
  if (activation.lastResult !== unavailable) {
    return;
  }
  activation.pending = void 0;
  activation.lastResult = void 0;
}

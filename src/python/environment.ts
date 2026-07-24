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
callers can invalidate anything cached against it. Carries no payload: the
only subscriber (`extension.ts`) invalidates unconditionally regardless of
which scope changed, so there is nothing for a payload to usefully convey. */
export const onDidChangeActivePythonEnvironment: vscode.Event<void> =
  activePythonEnvironmentChangeEmitter.event;

const unavailable = Symbol("unavailable");

/** Disposables registered while activating the classic Python extension
(`ms-python.python`)'s environment API -- currently just its
`onDidChangeActiveEnvironmentPath` listener. `initializePythonEnvironment()`
bridges this into whichever `vscode.Disposable[]` its caller passes (e.g.
`context.subscriptions`), so it's cleaned up on deactivate instead of
leaking. */
const providerDisposables: vscode.Disposable[] = [];

function disposeProviderDisposables(): void {
  for (const disposable of providerDisposables) {
    disposable.dispose();
  }
  providerDisposables.length = 0;
}

/** Activates the classic Python extension (`ms-python.python`), registering
its active-environment-changed listener. Never throws: a missing, disabled,
or failed-to-activate extension resolves to `unavailable` instead -- djLint
falls back to its bundled runtime whenever this integration isn't available,
so a failure here must never propagate as an error. */
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

/** Memoizes `activateClassicPythonExtension()`: the in-flight (or resolved)
promise is stashed synchronously in `pending`, so concurrent callers share
one activation attempt instead of racing. A `typeof unavailable` outcome is
cached too (in `lastResult`), so we don't keep retrying on every call --
until `resetPythonEnvironmentProviderIfUnavailable()` clears that latched
failure, letting a later call retry activation from scratch. A
successfully-activated extension is never reset: `lastResult` only gets
cleared when it's `unavailable`, so a working extension's listener
registration never runs more than once. */
const activation: {
  pending: Promise<PythonExtensionApi | typeof unavailable> | undefined;
  lastResult: PythonExtensionApi | typeof unavailable | undefined;
} = { lastResult: void 0, pending: void 0 };

async function getClassicPythonExtension(
  outputChannel?: vscode.LogOutputChannel,
): Promise<PythonExtensionApi | null> {
  activation.pending ??= activateClassicPythonExtension(outputChannel);
  const result = await activation.pending;
  /* eslint-disable-next-line require-atomic-updates -- intentional: this is
  the memoization itself, not a bug. Every concurrent caller awaits the SAME
  `activation.pending` promise (coalesced just above), so they all compute
  the same `result` and (harmlessly, redundantly) write the same value here;
  nothing reads/writes `activation.lastResult` in between to actually race
  against. */
  activation.lastResult = result;
  return result === unavailable ? null : result;
}

/** Kicks off (or joins, if activation is already in flight/resolved) the
classic Python extension's activation, and bridges its disposables into
`disposables` (typically `context.subscriptions`) so they're cleaned up on
deactivate. Intended to be called exactly once, early in `extension.ts`'s
`activate()`, so the environment-changed listener is wired up before any
format/lint call could need it -- but calling it again is harmless, since
activation itself only ever runs once (see `getClassicPythonExtension()`'s
memoization above). */
export async function initializePythonEnvironment(
  disposables: vscode.Disposable[],
  outputChannel?: vscode.LogOutputChannel,
): Promise<void> {
  disposables.push({ dispose: disposeProviderDisposables });
  await getClassicPythonExtension(outputChannel);
}

function toClassicEnvironmentDetails(
  environment: ResolvedEnvironment,
): PythonEnvironmentDetails {
  const executable = environment.executable.uri?.fsPath;
  return { command: executable == null ? null : { args: [], executable } };
}

/** Resolves the active Python environment for a file, folder, or workspace,
via the classic Python extension (`ms-python.python`). That extension is
optional: djLint falls back to a bundled runtime when it isn't installed, so
this returns `null` -- never throws -- when it is unavailable, INCLUDING
when the extension itself throws from `getActiveEnvironmentPath()` or
`resolveEnvironment()` (a misbehaving Python extension must not break the
resolution/fallback chain in `runner.ts`). */
export async function getActivePythonEnvironment(
  uri?: vscode.Uri,
): Promise<PythonEnvironmentDetails | null> {
  const api = await getClassicPythonExtension();
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

/** Un-latches a previously memoized "the classic Python extension is
unavailable" outcome, so the next `getActivePythonEnvironment()` (or
`initializePythonEnvironment()`) call retries activation from scratch
instead of staying pinned to a transient failure (e.g. the Python extension
still installing) for the rest of the session. A successfully-activated
extension is left untouched -- this never forces a working extension to
re-activate or re-register its listener. Safe to call unconditionally;
wired into `resolveDjlintCommand`'s cache invalidation path
(`invalidateDjlintCommandCache()` in `runner.ts`) so a retry is attempted
whenever anything else that could affect djLint resolution changes. */
export function resetPythonEnvironmentProviderIfUnavailable(): void {
  if (activation.lastResult !== unavailable) {
    return;
  }
  activation.pending = void 0;
  activation.lastResult = void 0;
}

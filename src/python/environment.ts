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
  sysPrefix: string;
}

/** Resolves the active Python environment via the classic Python extension
(`ms-python.python`). That extension is optional: djLint falls back to a
bundled runtime when it isn't installed, so `getEnvironmentProvider()`
returns `null` rather than throwing when it is unavailable. */
export interface EnvironmentProvider {
  initialize: (disposables: vscode.Disposable[]) => Promise<void>;

  /** Resolve the active Python environment for a file, folder, or workspace. */
  getActiveEnvironment: (
    uri?: vscode.Uri,
  ) => Promise<PythonEnvironmentDetails | null>;
}

export interface PythonEnvironmentChangeEventArgs {
  path?: string;
  uri?: vscode.Uri;
}

const activePythonEnvironmentChangeEmitter =
  new vscode.EventEmitter<PythonEnvironmentChangeEventArgs>();

/** Fired by the provider when the active Python interpreter for a scope
changes, so callers can invalidate anything cached against it. */
export const onDidChangeActivePythonEnvironment: vscode.Event<PythonEnvironmentChangeEventArgs> =
  activePythonEnvironmentChangeEmitter.event;

/** Fires `onDidChangeActivePythonEnvironment`, omitting `path`/`uri` keys that are absent rather than setting them to `undefined` (required to satisfy `exactOptionalPropertyTypes` on the optional-property event payload). */
function fireActivePythonEnvironmentChange(change: {
  path: string | undefined;
  uri: vscode.Uri | undefined;
}): void {
  const args: PythonEnvironmentChangeEventArgs = {};
  if (change.path != null) {
    args.path = change.path;
  }
  if (change.uri != null) {
    args.uri = change.uri;
  }
  activePythonEnvironmentChangeEmitter.fire(args);
}

const unavailable = Symbol("unavailable");

async function resolveOrUnavailable<T>(
  factory: (outputChannel: vscode.LogOutputChannel) => Promise<T | null>,
  outputChannel: vscode.LogOutputChannel,
): Promise<T | typeof unavailable> {
  const result = await factory(outputChannel);
  return result ?? unavailable;
}

/** Disposables registered by `EnvironmentProvider.initialize()` (see
`tryActivateClassicPythonExtension()` below), owned by the provider once it
successfully activates. `extension.ts` pushes `disposeEnvironmentProviders`
into `context.subscriptions` so this VS Code listener is cleaned up on
deactivate instead of leaking. */
const providerDisposables: vscode.Disposable[] = [];

/** Disposes every listener registered so far via `EnvironmentProvider.initialize()`
(see `providerDisposables`) and forgets them. Intended to be called exactly
once, on extension deactivate. */
export function disposeEnvironmentProviders(): void {
  for (const disposable of providerDisposables) {
    disposable.dispose();
  }
  providerDisposables.length = 0;
}

/** Wraps a `tryActivate`-style factory so it runs at most once: the
in-flight (or resolved) promise is memoized synchronously, so concurrent
callers share one activation attempt instead of racing. A `null` result
(extension absent, disabled, or failed to activate) is cached as
"unavailable" so we don't keep retrying on every call — until
`resetIfUnavailable()` clears that latched failure (see
`resetUnavailableEnvironmentProviders`), letting a later call retry
activation from scratch. A successfully-activated provider is never reset:
`resetIfUnavailable()` only ever discards a memoized "unavailable" outcome,
so a real provider's `initialize()` (and its listener registration) never
runs more than once. */
function lazyInit<T>(
  factory: (outputChannel: vscode.LogOutputChannel) => Promise<T | null>,
): {
  get: (outputChannel: vscode.LogOutputChannel) => Promise<T | null>;
  resetIfUnavailable: () => void;
} {
  let pending: Promise<T | typeof unavailable> | undefined;
  let lastResult: T | typeof unavailable | undefined;

  return {
    async get(outputChannel): Promise<T | null> {
      pending ??= resolveOrUnavailable(factory, outputChannel);
      const result = await pending;
      lastResult = result;
      return result === unavailable ? null : result;
    },
    resetIfUnavailable(): void {
      if (lastResult !== unavailable) {
        return;
      }
      pending = void 0;
      lastResult = void 0;
    },
  };
}

function toClassicEnvironmentDetails(
  environment: ResolvedEnvironment,
): PythonEnvironmentDetails {
  const executable = environment.executable.uri?.fsPath;

  return {
    command: executable == null ? null : { args: [], executable },
    sysPrefix: environment.executable.sysPrefix,
  };
}

/** Facade for the classic Python extension (`ms-python.python`)'s
environment API. */
class ClassicPythonExtension implements EnvironmentProvider {
  constructor(
    private readonly api: PythonExtensionApi,
    private readonly outputChannel: vscode.LogOutputChannel,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- the EnvironmentProvider interface requires Promise<void>, but registering the listener below is synchronous.
  async initialize(disposables: vscode.Disposable[]): Promise<void> {
    this.outputChannel.info(
      "Using the Python extension for Python environment detection",
    );
    disposables.push(
      this.api.environments.onDidChangeActiveEnvironmentPath((event) => {
        fireActivePythonEnvironmentChange({
          path: event.path,
          uri:
            event.resource instanceof vscode.Uri
              ? event.resource
              : event.resource?.uri,
        });
      }),
    );
  }

  async getActiveEnvironment(
    uri?: vscode.Uri,
  ): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.api.environments.resolveEnvironment(
      this.api.environments.getActiveEnvironmentPath(uri),
    );
    return environment == null
      ? null
      : toClassicEnvironmentDetails(environment);
  }
}

async function tryActivateClassicPythonExtension(
  outputChannel: vscode.LogOutputChannel,
): Promise<ClassicPythonExtension | null> {
  outputChannel.info("Initializing the Python extension");
  try {
    const api = await PythonExtensionApi.api();
    const provider = new ClassicPythonExtension(api, outputChannel);
    await provider.initialize(providerDisposables);
    return provider;
  } catch (e) {
    outputChannel.warn(`The Python extension is not available: ${String(e)}`);
    return null;
  }
}

const classicPythonExtension = lazyInit(tryActivateClassicPythonExtension);

async function getClassicPythonExtension(
  outputChannel: vscode.LogOutputChannel,
): Promise<ClassicPythonExtension | null> {
  return classicPythonExtension.get(outputChannel);
}

/** Resolve the classic Python extension's environment provider, or `null` if
it is not installed or fails to activate. Never throws. */
export async function getEnvironmentProvider(
  outputChannel: vscode.LogOutputChannel,
): Promise<EnvironmentProvider | null> {
  return getClassicPythonExtension(outputChannel);
}

/** Un-latches a previously memoized "no environment provider available"
outcome for the classic Python extension, so the next
`getEnvironmentProvider()` call retries activation from scratch instead of
staying pinned to a transient failure (e.g. the Python extension still
installing) for the rest of the session. A provider that DID activate
successfully is left untouched — this never forces a working provider to
re-activate or re-register its listeners. Safe to call unconditionally;
wired into `resolveDjlintCommand`'s cache invalidation path
(`invalidateDjlintCommandCache()` in `runner.ts`) so a retry is attempted
whenever anything else that could affect djLint resolution changes. */
export function resetUnavailableEnvironmentProviders(): void {
  classicPythonExtension.resetIfUnavailable();
}

import { isDeepStrictEqual } from "node:util";
import {
  PythonExtension as PythonExtensionApi,
  type ResolvedEnvironment,
} from "@vscode/python-extension";
import type {
  DidChangeEnvironmentEventArgs,
  PythonEnvironment,
  PythonEnvironmentApi,
} from "@vscode/python-environments";
import * as vscode from "vscode";
import {
  createEnvironmentChangeCache,
  type EnvironmentChangeCache,
} from "./environment-cache.js";
import { parsePythonVersion } from "./python-version.js";

const pythonEnvironmentsExtensionId = "ms-python.vscode-python-envs";

export interface PythonCommand {
  args: readonly string[];
  executable: string;
}

export interface PythonEnvironmentDetails {
  command: PythonCommand | null;
  sysPrefix: string;
  version: {
    major: number;
    minor: number;
    patch: number | null;
  } | null;
}

/** Resolves Python environments from a single source (the Python
Environments extension or the classic Python extension). Both are optional
in this extension: djLint falls back to a bundled runtime when neither is
installed, so `getEnvironmentProvider()` returns `null` rather than throwing
when no provider is available. */
export interface EnvironmentProvider {
  initialize: (disposables: vscode.Disposable[]) => Promise<void>;

  /** Resolve a Python executable or environment directory to an environment. */
  resolveInterpreter: (
    path: string,
  ) => Promise<PythonEnvironmentDetails | null>;

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

/** Fired by whichever provider is in use when the active Python interpreter
for a scope changes, so callers can invalidate anything cached against it. */
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

/** Wraps a `tryActivate`-style factory so it runs at most once: the
in-flight (or resolved) promise is memoized synchronously, so concurrent
callers share one activation attempt instead of racing. A `null` result
(extension absent, disabled, or failed to activate) is cached as
"unavailable" so we don't keep retrying on every call. */
function lazyInit<T>(
  factory: (outputChannel: vscode.LogOutputChannel) => Promise<T | null>,
): {
  get: (outputChannel: vscode.LogOutputChannel) => Promise<T | null>;
} {
  let pending: Promise<T | typeof unavailable> | undefined;

  return {
    async get(outputChannel): Promise<T | null> {
      pending ??= resolveOrUnavailable(factory, outputChannel);
      const result = await pending;
      return result === unavailable ? null : result;
    },
  };
}

function toClassicEnvironmentDetails(
  environment: ResolvedEnvironment,
): PythonEnvironmentDetails {
  const { version } = environment;
  const executable = environment.executable.uri?.fsPath;

  return {
    command: executable == null ? null : { args: [], executable },
    sysPrefix: environment.executable.sysPrefix,
    version:
      version == null
        ? null
        : { major: version.major, minor: version.minor, patch: version.micro },
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

  async resolveInterpreter(
    path: string,
  ): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.api.environments.resolveEnvironment(path);
    return environment == null ? null : toClassicEnvironmentDetails(environment);
  }

  async getActiveEnvironment(
    uri?: vscode.Uri,
  ): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.api.environments.resolveEnvironment(
      this.api.environments.getActiveEnvironmentPath(uri),
    );
    return environment == null ? null : toClassicEnvironmentDetails(environment);
  }
}

async function tryActivateClassicPythonExtension(
  outputChannel: vscode.LogOutputChannel,
): Promise<ClassicPythonExtension | null> {
  outputChannel.info("Initializing the Python extension");
  try {
    const api = await PythonExtensionApi.api();
    return new ClassicPythonExtension(api, outputChannel);
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

/** Facade for the dedicated Python Environments extension
(`ms-python.vscode-python-envs`)'s API. */
class PythonEnvironmentsExtension implements EnvironmentProvider {
  readonly #activeEnvironments: EnvironmentChangeCache<PythonEnvironmentDetails | null> =
    createEnvironmentChangeCache();

  constructor(
    private readonly api: PythonEnvironmentApi,
    private readonly outputChannel: vscode.LogOutputChannel,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- the EnvironmentProvider interface requires Promise<void>, but registering the listener below is synchronous.
  async initialize(disposables: vscode.Disposable[]): Promise<void> {
    this.outputChannel.info(
      "Using the Python Environments extension for Python environment detection",
    );

    // Server startup resolves the active environment on demand; avoid a global lookup here, since it can trigger full environment discovery and block activation.

    disposables.push(
      this.api.onDidChangeEnvironment((event) => {
        this.#handleEnvironmentChange(event);
      }),
    );
  }

  async resolveInterpreter(
    path: string,
  ): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.api.resolveEnvironment(
      vscode.Uri.file(path),
    );
    return environment == null ? null : this.#toEnvironmentDetails(environment);
  }

  async getActiveEnvironment(
    uri?: vscode.Uri,
  ): Promise<PythonEnvironmentDetails | null> {
    const environment = await this.api.getEnvironment(uri);
    const details =
      environment == null ? null : this.#toEnvironmentDetails(environment);

    this.#activeEnvironments.remember(uri?.toString(), details);
    if (details != null) {
      this.outputChannel.debug(`Resolved Python environment: '${details.sysPrefix}'`);
    }
    return details;
  }

  #handleEnvironmentChange(event: DidChangeEnvironmentEventArgs): void {
    const key = event.uri?.toString();
    const environment =
      event.new == null ? null : this.#toEnvironmentDetails(event.new);
    const previousEnvironment =
      event.old == null ? null : this.#toEnvironmentDetails(event.old);

    // The extension emits duplicate change events. Compare the event's own old/new pair first: a scope our cache has not seen yet must not be reported as "changed" just because the event itself reports no change.
    if (isDeepStrictEqual(previousEnvironment, environment)) {
      this.#activeEnvironments.remember(key, environment);
      this.#logIgnoredChange(event.uri);
      return;
    }

    if (!this.#activeEnvironments.record(key, environment)) {
      this.#logIgnoredChange(event.uri);
      return;
    }

    fireActivePythonEnvironmentChange({
      path: environment?.command?.executable,
      uri: event.uri,
    });
  }

  #logIgnoredChange(uri: vscode.Uri | undefined): void {
    this.outputChannel.debug(
      `Ignoring a Python Environments change event because the active environment is unchanged for '${uri?.toString() ?? "workspace"}'.`,
    );
  }

  #toEnvironmentDetails(
    environment: PythonEnvironment,
  ): PythonEnvironmentDetails | null {
    if (environment.error != null) {
      this.outputChannel.warn(
        `Ignoring the '${environment.environmentPath.fsPath}' environment because it has errors: ${environment.error}`,
      );
      return null;
    }

    return {
      command: {
        args: environment.execInfo.run.args ?? [],
        executable: environment.execInfo.run.executable,
      },
      sysPrefix: environment.sysPrefix,
      version: parsePythonVersion(environment.version),
    };
  }
}

async function tryActivatePythonEnvironmentsExtension(
  outputChannel: vscode.LogOutputChannel,
): Promise<PythonEnvironmentsExtension | null> {
  // Parameterized with `| undefined` (rather than just `PythonEnvironmentApi`) because `.exports` is genuinely `undefined` at runtime when the user disables `python.useEnvironmentsExtension` — the plain generic would type it as always present and make the null-check below look unreachable to the type checker.
  const extension = vscode.extensions.getExtension<
    PythonEnvironmentApi | undefined
  >(pythonEnvironmentsExtensionId);

  if (extension == null) {
    outputChannel.info(
      "The Python Environments extension is not installed or is disabled.",
    );
    return null;
  }

  if (!extension.isActive) {
    try {
      outputChannel.info("Activating the Python Environments extension");
      await extension.activate();
    } catch (e) {
      outputChannel.warn(
        `Failed to activate the Python Environments extension: ${String(e)}`,
      );
      return null;
    }
  }

  // No API is exported when the user disables `python.useEnvironmentsExtension`.
  if (extension.exports == null) {
    outputChannel.info(
      "The Python Environments extension is disabled by 'python.useEnvironmentsExtension'.",
    );
    return null;
  }

  return new PythonEnvironmentsExtension(extension.exports, outputChannel);
}

const pythonEnvironmentsExtension = lazyInit(
  tryActivatePythonEnvironmentsExtension,
);

async function getPythonEnvironmentsExtension(
  outputChannel: vscode.LogOutputChannel,
): Promise<PythonEnvironmentsExtension | null> {
  return pythonEnvironmentsExtension.get(outputChannel);
}

/** Prefer the Python Environments extension; fall back to the classic
Python extension; return `null` if neither is usable. Never throws. */
export async function getEnvironmentProvider(
  outputChannel: vscode.LogOutputChannel,
): Promise<EnvironmentProvider | null> {
  return (
    (await getPythonEnvironmentsExtension(outputChannel)) ??
    (await getClassicPythonExtension(outputChannel))
  );
}

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

interface EnvironmentProvider {
  getActiveEnvironment: (
    uri: vscode.Uri | undefined,
  ) => Promise<PythonEnvironmentDetails | null>;
}

const activePythonEnvironmentChangeEmitter = new vscode.EventEmitter<void>();

export const onDidChangeActivePythonEnvironment: vscode.Event<void> =
  activePythonEnvironmentChangeEmitter.event;

const unavailable = Symbol("unavailable");

const providerDisposables: vscode.Disposable[] = [];

function disposeProviderDisposables(): void {
  for (const disposable of providerDisposables) {
    disposable.dispose();
  }
  providerDisposables.length = 0;
}

function environmentScopeKey(uri: vscode.Uri | undefined): string {
  return uri?.toString() ?? "";
}

function toPythonEnvironmentsDetails(
  environment: PythonEnvironment | undefined,
): PythonEnvironmentDetails | null {
  if (environment == null || environment.error) {
    return null;
  }
  const { run } = environment.execInfo;
  return { command: { args: run.args ?? [], executable: run.executable } };
}

function createPythonEnvironmentsProvider(
  api: PythonEnvironmentApi,
  outputChannel: vscode.LogOutputChannel | undefined,
): EnvironmentProvider {
  const lastSeen = new Map<string, PythonEnvironmentDetails | null>();

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
      const isUnchanged =
        isDeepStrictEqual(
          lastSeen.get(environmentScopeKey(event.uri)),
          details,
        ) || isDeepStrictEqual(previous, details);
      rememberScope(event.uri, details);
      if (isUnchanged) {
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
  try {
    const api = extension.isActive
      ? extension.exports
      : await extension.activate();
    if (api == null) {
      outputChannel?.info(
        "The Python Environments extension exports no API; it is disabled by python.useEnvironmentsExtension.",
      );
      return null;
    }
    const provider = createPythonEnvironmentsProvider(api, outputChannel);
    outputChannel?.info(
      "Using the Python Environments extension for Python environment detection",
    );
    return provider;
  } catch (e) {
    outputChannel?.warn(
      `The Python Environments extension is not available: ${String(e)}`,
    );
    return null;
  }
}

function toClassicEnvironmentDetails(
  environment: ResolvedEnvironment,
): PythonEnvironmentDetails {
  const executable = environment.executable.uri?.fsPath;
  return { command: executable == null ? null : { args: [], executable } };
}

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

async function activateClassicPythonExtension(
  outputChannel: vscode.LogOutputChannel | undefined,
): Promise<EnvironmentProvider | null> {
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

async function activateEnvironmentProvider(
  outputChannel: vscode.LogOutputChannel | undefined,
): Promise<EnvironmentProvider | typeof unavailable> {
  const provider =
    (await activatePythonEnvironmentsExtension(outputChannel)) ??
    (await activateClassicPythonExtension(outputChannel));
  return provider ?? unavailable;
}

const activation: {
  lastResult: EnvironmentProvider | typeof unavailable | undefined;
  pending: Promise<EnvironmentProvider | typeof unavailable> | undefined;
} = { lastResult: void 0, pending: void 0 };

async function getEnvironmentProvider(
  outputChannel?: vscode.LogOutputChannel,
): Promise<EnvironmentProvider | null> {
  activation.pending ??= activateEnvironmentProvider(outputChannel);
  const result = await activation.pending;
  // eslint-disable-next-line require-atomic-updates -- concurrent callers share one pending promise and redundantly write the same result
  activation.lastResult = result;
  return result === unavailable ? null : result;
}

const pythonEnvironmentInit: {
  outputChannel: vscode.LogOutputChannel | undefined;
} = { outputChannel: void 0 };

export function initializePythonEnvironment(
  disposables: vscode.Disposable[],
  outputChannel?: vscode.LogOutputChannel,
): void {
  disposables.push({ dispose: disposeProviderDisposables });
  pythonEnvironmentInit.outputChannel = outputChannel;
}

export async function getActivePythonEnvironment(
  uri?: vscode.Uri,
): Promise<PythonEnvironmentDetails | null> {
  try {
    const provider = await getEnvironmentProvider(
      pythonEnvironmentInit.outputChannel,
    );
    return (await provider?.getActiveEnvironment(uri)) ?? null;
  } catch {
    return null;
  }
}

export function resetPythonEnvironmentProviderIfUnavailable(): void {
  if (activation.lastResult !== unavailable) {
    return;
  }
  activation.pending = void 0;
  activation.lastResult = void 0;
}

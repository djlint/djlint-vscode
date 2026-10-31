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

function toClassicEnvironmentDetails(
  environment: ResolvedEnvironment,
): PythonEnvironmentDetails {
  const executable = environment.executable.uri?.fsPath;
  return { command: executable == null ? null : { args: [], executable } };
}

export class PythonEnvironments implements vscode.Disposable {
  readonly onDidChange: vscode.Event<void>;

  readonly #changeEmitter = new vscode.EventEmitter<void>();
  readonly #disposables: vscode.Disposable[] = [this.#changeEmitter];
  #provider: Promise<EnvironmentProvider | null> | undefined;
  #isUnavailable = false;

  constructor(private readonly outputChannel: vscode.LogOutputChannel) {
    this.onDidChange = this.#changeEmitter.event;
  }

  async getActive(
    uri: vscode.Uri | undefined,
  ): Promise<PythonEnvironmentDetails | null> {
    try {
      this.#provider ??= this.#activateProvider();
      const provider = await this.#provider;
      return (await provider?.getActiveEnvironment(uri)) ?? null;
    } catch {
      return null;
    }
  }

  resetIfUnavailable(): void {
    if (!this.#isUnavailable) {
      return;
    }
    this.#provider = void 0;
    this.#isUnavailable = false;
  }

  dispose(): void {
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
    this.#disposables.length = 0;
  }

  async #activateProvider(): Promise<EnvironmentProvider | null> {
    const provider =
      (await this.#activatePythonEnvironmentsExtension()) ??
      (await this.#activateClassicPythonExtension());
    this.#isUnavailable = provider == null;
    return provider;
  }

  async #activatePythonEnvironmentsExtension(): Promise<EnvironmentProvider | null> {
    const extension = vscode.extensions.getExtension<
      PythonEnvironmentApi | undefined
    >(pythonEnvironmentsExtensionId);
    if (extension == null) {
      this.outputChannel.info(
        "The Python Environments extension is not installed or is disabled.",
      );
      return null;
    }

    this.outputChannel.info("Initializing the Python Environments extension");
    try {
      const api = extension.isActive
        ? extension.exports
        : await extension.activate();
      if (api == null) {
        this.outputChannel.info(
          "The Python Environments extension exports no API; it is disabled by python.useEnvironmentsExtension.",
        );
        return null;
      }
      const provider = this.#createPythonEnvironmentsProvider(api);
      this.outputChannel.info(
        "Using the Python Environments extension for Python environment detection",
      );
      return provider;
    } catch (e) {
      this.outputChannel.warn(
        `The Python Environments extension is not available: ${String(e)}`,
      );
      return null;
    }
  }

  #createPythonEnvironmentsProvider(
    api: PythonEnvironmentApi,
  ): EnvironmentProvider {
    const lastSeen = new Map<string, PythonEnvironmentDetails | null>();

    this.#disposables.push(
      api.onDidChangeEnvironment((event) => {
        const details = toPythonEnvironmentsDetails(event.new);
        const previous = toPythonEnvironmentsDetails(event.old);
        const key = environmentScopeKey(event.uri);
        const isUnchanged =
          isDeepStrictEqual(lastSeen.get(key), details) ||
          isDeepStrictEqual(previous, details);
        lastSeen.set(key, details);
        if (isUnchanged) {
          this.outputChannel.debug(
            `Ignoring a Python Environments change event for "${event.uri?.toString() ?? "workspace"}": the active environment is unchanged.`,
          );
          return;
        }
        this.#changeEmitter.fire();
      }),
    );

    const getActiveEnvironment = async (
      uri: vscode.Uri | undefined,
    ): Promise<PythonEnvironmentDetails | null> => {
      const environment = await api.getEnvironment(uri);
      if (environment?.error) {
        this.outputChannel.warn(
          `Ignoring the Python environment at "${environment.environmentPath.toString()}": ${environment.error}`,
        );
      }
      const details = toPythonEnvironmentsDetails(environment);
      lastSeen.set(environmentScopeKey(uri), details);
      return details;
    };

    return { getActiveEnvironment };
  }

  async #activateClassicPythonExtension(): Promise<EnvironmentProvider | null> {
    if (vscode.extensions.getExtension(pythonExtensionId) == null) {
      this.outputChannel.info(
        "The Python extension is not installed or is disabled.",
      );
      return null;
    }

    this.outputChannel.info("Initializing the Python extension");
    try {
      const provider = this.#createClassicPythonProvider(
        await PythonExtensionApi.api(),
      );
      this.outputChannel.info(
        "Using the Python extension for Python environment detection",
      );
      return provider;
    } catch (e) {
      this.outputChannel.warn(
        `The Python extension is not available: ${String(e)}`,
      );
      return null;
    }
  }

  #createClassicPythonProvider(api: PythonExtensionApi): EnvironmentProvider {
    this.#disposables.push(
      api.environments.onDidChangeActiveEnvironmentPath(() => {
        this.#changeEmitter.fire();
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
}

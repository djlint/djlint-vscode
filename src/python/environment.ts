import { isDeepStrictEqual } from "node:util";

import { EXTENSION_ID as pythonEnvironmentsExtensionId } from "@vscode/python-environments";
import type { PythonEnvironment, PythonEnvironmentApi } from "@vscode/python-environments";
import {
  PythonExtension as PythonExtensionApi,
  PVSC_EXTENSION_ID as pythonExtensionId,
} from "@vscode/python-extension";
import type { ResolvedEnvironment } from "@vscode/python-extension";
import * as vscode from "vscode";

export const ENVIRONMENT_TIMEOUT_MS = 30_000;

const STALLED = Symbol("stalled");

interface PythonCommand {
  args: readonly string[];
  executable: string;
}

export interface PythonEnvironmentDetails {
  command: PythonCommand | null;
}

interface EnvironmentProvider {
  getActiveEnvironment: (uri: vscode.Uri | undefined) => Promise<PythonEnvironmentDetails | null>;
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

function toClassicEnvironmentDetails(environment: ResolvedEnvironment): PythonEnvironmentDetails {
  const executable = environment.executable.uri?.fsPath;
  return { command: executable == null ? null : { args: [], executable } };
}

export class PythonEnvironments implements vscode.Disposable {
  readonly onDidChange: vscode.Event<void>;

  readonly #changeEmitter = new vscode.EventEmitter<void>();
  readonly #disposables: vscode.Disposable[] = [this.#changeEmitter];
  #provider: Promise<EnvironmentProvider | null> | undefined;
  #isUnavailable = false;
  #isStalled = false;
  readonly #outputChannel: vscode.LogOutputChannel;

  constructor(outputChannel: vscode.LogOutputChannel) {
    this.#outputChannel = outputChannel;
    this.onDidChange = this.#changeEmitter.event;
    this.#disposables.push(
      this.#changeEmitter.event(() => {
        this.#isStalled = false;
      }),
      vscode.extensions.onDidChange(() => {
        if (!this.#isUnavailable) {
          return;
        }
        this.resetIfUnavailable();
        this.#changeEmitter.fire();
      }),
    );
  }

  async getActive(uri: vscode.Uri | undefined): Promise<PythonEnvironmentDetails | null> {
    if (this.#isStalled) {
      return null;
    }
    const lookup = this.#lookUp(uri);
    const { promise: timedOut, resolve } = Promise.withResolvers<typeof STALLED>();
    const timer = setTimeout(() => {
      resolve(STALLED);
    }, ENVIRONMENT_TIMEOUT_MS);
    const result = await Promise.race([lookup, timedOut]);
    clearTimeout(timer);
    if (result !== STALLED) {
      return result;
    }
    this.#outputChannel.warn(
      "The Python extension is not answering; going on without the active environment until it does.",
    );
    this.#isStalled = true;
    // oxlint-disable-next-line promise/always-return, promise/prefer-await-to-then -- the caller goes on without it
    void lookup.then(() => {
      if (this.#isStalled) {
        this.#changeEmitter.fire();
      }
    });
    return null;
  }

  resetIfUnavailable(): void {
    this.#isStalled = false;
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

  async #lookUp(uri: vscode.Uri | undefined): Promise<PythonEnvironmentDetails | null> {
    try {
      this.#provider ??= this.#activateProvider();
      const provider = await this.#provider;
      return (await provider?.getActiveEnvironment(uri)) ?? null;
    } catch {
      return null;
    }
  }

  async #activateProvider(): Promise<EnvironmentProvider | null> {
    // The Python extension installs the other one, which exports an API even with this off, without what is selected in the Python extension.
    const isOn = vscode.workspace
      .getConfiguration("python")
      .get<boolean>("useEnvironmentsExtension");
    const provider = isOn
      ? ((await this.#activatePythonEnvironmentsExtension()) ??
        (await this.#activateClassicPythonExtension()))
      : ((await this.#activateClassicPythonExtension()) ??
        (await this.#activatePythonEnvironmentsExtension()));
    this.#isUnavailable = provider == null;
    return provider;
  }

  async #activatePythonEnvironmentsExtension(): Promise<EnvironmentProvider | null> {
    const extension = vscode.extensions.getExtension<PythonEnvironmentApi | undefined>(
      pythonEnvironmentsExtensionId,
    );
    if (extension == null) {
      this.#outputChannel.info(
        "The Python Environments extension is not installed or is disabled.",
      );
      return null;
    }

    this.#outputChannel.info("Initializing the Python Environments extension");
    try {
      const api = extension.isActive ? extension.exports : await extension.activate();
      if (api == null) {
        this.#outputChannel.info(
          "The Python Environments extension exports no API; it is disabled by python.useEnvironmentsExtension.",
        );
        return null;
      }
      const provider = this.#createPythonEnvironmentsProvider(api);
      this.#outputChannel.info(
        "Using the Python Environments extension for Python environment detection",
      );
      return provider;
    } catch (e) {
      this.#outputChannel.warn(`The Python Environments extension is not available: ${String(e)}`);
      return null;
    }
  }

  #createPythonEnvironmentsProvider(api: PythonEnvironmentApi): EnvironmentProvider {
    const lastSeen = new Map<string, PythonEnvironmentDetails | null>();

    this.#disposables.push(
      api.onDidChangeEnvironment((event) => {
        const details = toPythonEnvironmentsDetails(event.new);
        const previous = toPythonEnvironmentsDetails(event.old);
        const key = environmentScopeKey(event.uri);
        const isUnchanged =
          isDeepStrictEqual(lastSeen.get(key), details) || isDeepStrictEqual(previous, details);
        lastSeen.set(key, details);
        if (isUnchanged) {
          this.#outputChannel.debug(
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
        this.#outputChannel.warn(
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
      this.#outputChannel.info("The Python extension is not installed or is disabled.");
      return null;
    }

    this.#outputChannel.info("Initializing the Python extension");
    try {
      const provider = this.#createClassicPythonProvider(await PythonExtensionApi.api());
      this.#outputChannel.info("Using the Python extension for Python environment detection");
      return provider;
    } catch (e) {
      this.#outputChannel.warn(`The Python extension is not available: ${String(e)}`);
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
      return environment == null ? null : toClassicEnvironmentDetails(environment);
    }

    return { getActiveEnvironment };
  }
}

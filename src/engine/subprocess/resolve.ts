import type * as vscode from "vscode";
import { configSection } from "../../config.js";
import type { PythonEnvironmentDetails } from "../../python/environment.js";
import { DjlintUnavailableError, RESOLUTION_TTL_MS } from "../types.js";

export interface RunnerCommand {
  exec: string;
  prefixArgs: readonly string[];
  version: string;
}

const MODULE_ARGS: readonly string[] = ["-m", "djlint"];

const PYTHONS_ON_PATH: readonly string[] = ["python3", "python"];

export interface ResolveDjlintCommandDeps {
  executablePath: string;
  pythonPath: string;
  getActiveEnvironment:
    | ((
        uri: vscode.Uri | undefined,
      ) => Promise<PythonEnvironmentDetails | null>)
    | null;
  uri: vscode.Uri | undefined;
  probe: (
    exec: string,
    prefixArgs: readonly string[],
  ) => Promise<string | null>;
  onConfiguredPathRejected: (setting: string, exec: string) => void;
}

export async function resolveDjlintCommand(
  deps: ResolveDjlintCommandDeps,
): Promise<RunnerCommand> {
  async function tryCommand(
    exec: string,
    prefixArgs: readonly string[],
  ): Promise<RunnerCommand | null> {
    const version = await deps.probe(exec, prefixArgs);
    return version == null ? null : { exec, prefixArgs, version };
  }

  const executablePath = deps.executablePath.trim();
  if (executablePath) {
    const command = await tryCommand(executablePath, []);
    if (command) {
      return command;
    }
    deps.onConfiguredPathRejected("executablePath", executablePath);
  }

  const pythonPath = deps.pythonPath.trim();
  if (pythonPath) {
    const command = await tryCommand(pythonPath, MODULE_ARGS);
    if (command) {
      return command;
    }
    deps.onConfiguredPathRejected("pythonPath", pythonPath);
  }

  const active = await deps.getActiveEnvironment?.(deps.uri);
  if (active?.command) {
    const { args, executable } = active.command;
    const command = await tryCommand(executable, [...args, ...MODULE_ARGS]);
    if (command) {
      return command;
    }
  }

  const onPath = await tryCommand("djlint", []);
  if (onPath) {
    return onPath;
  }

  for (const python of PYTHONS_ON_PATH) {
    // eslint-disable-next-line no-await-in-loop -- the first one that works wins
    const command = await tryCommand(python, MODULE_ARGS);
    if (command) {
      return command;
    }
  }

  throw new DjlintUnavailableError(
    `Could not find djLint. Set ${configSection}.executablePath, ${configSection}.pythonPath, or install djLint so it is available on PATH.`,
  );
}

interface CommandCacheEntry {
  command: RunnerCommand;
  resolvedAt: number;
}

export class CommandResolver {
  readonly #cache = new Map<string, CommandCacheEntry>();
  readonly #inFlight = new Map<string, Promise<RunnerCommand>>();
  #epoch = 0;

  invalidate(): void {
    this.#epoch += 1;
    this.#cache.clear();
    this.#inFlight.clear();
  }

  async resolve(
    deps: ResolveDjlintCommandDeps,
    scopeKey: string,
  ): Promise<RunnerCommand> {
    const cached = this.#cache.get(scopeKey);
    if (cached != null && Date.now() - cached.resolvedAt < RESOLUTION_TTL_MS) {
      return cached.command;
    }

    const pending =
      this.#inFlight.get(scopeKey) ?? this.#resolveAndCache(deps, scopeKey);
    this.#inFlight.set(scopeKey, pending);
    try {
      return await pending;
    } finally {
      if (this.#inFlight.get(scopeKey) === pending) {
        this.#inFlight.delete(scopeKey);
      }
    }
  }

  async #resolveAndCache(
    deps: ResolveDjlintCommandDeps,
    scopeKey: string,
  ): Promise<RunnerCommand> {
    const epochAtStart = this.#epoch;
    const command = await resolveDjlintCommand(deps);
    if (epochAtStart === this.#epoch) {
      this.#cache.set(scopeKey, { command, resolvedAt: Date.now() });
    }
    return command;
  }
}

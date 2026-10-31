import { configSection } from "../../config.js";
import type { PythonEnvironmentDetails } from "../../python/environment.js";
import { DjlintUnavailableError, RESOLUTION_TTL_MS } from "../types.js";

export interface RunnerCommand {
  exec: string;
  prefixArgs: readonly string[];
  version: string | null;
}

/** The version, null if djLint is not there, undefined if the probe cannot tell: it failed or timed out. */
export type ProbeResult = string | null | undefined;

const MODULE_ARGS: readonly string[] = ["-m", "djlint"];

const PYTHONS_ON_PATH: readonly string[] = ["python", "python3"];

export interface ResolveDjlintCommandDeps {
  executablePath: string;
  pythonPath: string;
  activeEnvironment: PythonEnvironmentDetails | null;
  probe: (exec: string, prefixArgs: readonly string[]) => Promise<ProbeResult>;
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
    if (version === void 0) {
      return { exec, prefixArgs, version: null };
    }
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

  if (deps.activeEnvironment?.command) {
    const { args, executable } = deps.activeEnvironment.command;
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
    // A python that cannot tell is no sign of a djLint: this is only a last look around.
    // eslint-disable-next-line no-await-in-loop -- the first one that works wins
    const version = await deps.probe(python, MODULE_ARGS);
    if (version != null) {
      return { exec: python, prefixArgs: MODULE_ARGS, version };
    }
  }

  throw new DjlintUnavailableError(
    `Could not find djLint. Set ${configSection}.executablePath, ${configSection}.pythonPath, or install djLint so it is available on PATH.`,
  );
}

interface CommandCacheEntry {
  outcome: DjlintUnavailableError | RunnerCommand;
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
      if (cached.outcome instanceof DjlintUnavailableError) {
        throw cached.outcome;
      }
      return cached.outcome;
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
    const remember = (outcome: CommandCacheEntry["outcome"]): void => {
      if (epochAtStart === this.#epoch) {
        this.#cache.set(scopeKey, { outcome, resolvedAt: Date.now() });
      }
    };
    try {
      const command = await resolveDjlintCommand(deps);
      if (command.version != null) {
        remember(command);
      }
      return command;
    } catch (e) {
      if (e instanceof DjlintUnavailableError) {
        remember(e);
      }
      throw e;
    }
  }
}

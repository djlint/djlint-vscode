import { x } from "tinyexec";
import type { Output, Result } from "tinyexec";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** What the command reads; without it, the command gets no input. */
  input?: string;
  signal?: AbortSignal;
  timeout: number;
}

export interface RunFailure {
  /** Why the command could not start, or could not get its input. */
  code?: string | undefined;
  exitCode?: number | undefined;
  signal?: string | undefined;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
}

function describeFailure({ code, exitCode, signal, timedOut }: RunFailure): string {
  if (timedOut === true) {
    return "Command timed out";
  }
  if (signal != null) {
    return `Command was killed with ${signal}`;
  }
  if (exitCode != null) {
    return `Command failed with exit code ${exitCode}`;
  }
  return code == null ? "Command failed" : `Command failed with ${code}`;
}

/** A command that did not exit with 0, including one that did not start. */
export class RunError extends Error {
  override name = "RunError";
  readonly code: string | undefined;
  readonly exitCode: number | undefined;
  readonly signal: string | undefined;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;

  constructor(command: string, failure: RunFailure, options?: ErrorOptions) {
    const { code, exitCode, signal, stderr = "", stdout = "", timedOut = false } = failure;
    super(
      [`${describeFailure(failure)}: ${command}`, stderr.trim()].filter(Boolean).join("\n\n"),
      options,
    );
    this.code = code;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
    this.stdout = stdout;
    this.timedOut = timedOut;
  }
}

function errorCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : void 0;
}

/**
 * Runs a command without a shell. On Windows tinyexec finds it as `cmd.exe` would, and runs a script by its shebang.
 * @param file - The command.
 * @param args - Its arguments.
 * @param options - Where and how long it runs, and what it reads.
 * @returns What the command printed, once it exits with 0.
 * @throws {RunError} When the command fails, cannot start, times out, or is stopped through `signal`.
 */
export async function run(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<{ stderr: string; stdout: string }> {
  const { cwd, env, input, signal, timeout } = options;
  const command = [file, ...args].join(" ");
  const timer = AbortSignal.timeout(timeout);
  let child: Result;
  let output: Output;
  try {
    child = x(file, args, {
      nodeOptions: { cwd, env, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] },
      // Not the node_modules/.bin folders above cwd, nor the folder of VS Code's own executable.
      nodePath: false,
      signal: signal == null ? timer : AbortSignal.any([signal, timer]),
      ...(input != null && { stdin: input }),
    });
    output = await child;
  } catch (e) {
    throw new RunError(command, timer.aborted ? { timedOut: true } : { code: errorCode(e) }, {
      cause: e,
    });
  }
  const { exitCode, stderr, stdout } = output;
  if (exitCode === 0) {
    return { stderr, stdout };
  }
  throw new RunError(command, { exitCode, signal: child.signalCode ?? void 0, stderr, stdout });
}

const NO_DJLINT_MODULE_REGEX = /No\s+module\s+named\s+['"]?djlint['"]?(?![\w.])/u;

const CANNOT_START: ReadonlySet<string | undefined> = new Set([
  "EACCES",
  "ENOENT",
  "ENOEXEC",
  "UNKNOWN",
]);

// How a shell, a version manager's shim, or on Windows a venv whose base Python is gone says that a command is not there.
const COMMAND_NOT_FOUND: ReadonlySet<number | undefined> = new Set([103, 127, 9009]);

export function isDjlintUnavailable(e: {
  code?: string | undefined;
  exitCode?: number | undefined;
  stderr: string;
}): boolean {
  return (
    CANNOT_START.has(e.code) ||
    COMMAND_NOT_FOUND.has(e.exitCode) ||
    NO_DJLINT_MODULE_REGEX.test(e.stderr)
  );
}

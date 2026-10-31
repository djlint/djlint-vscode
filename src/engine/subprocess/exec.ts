import { ExecaError } from "execa";

export interface ChildOptions {
  input: string;
  stripFinalNewline: boolean;
  cwd?: string;
  cancelSignal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  timeout: number;
}

export type CustomExecaError = ExecaError<ChildOptions>;

export function isCustomExecaError(e: unknown): e is CustomExecaError {
  return e instanceof ExecaError;
}

const NO_DJLINT_MODULE_REGEX =
  /No\s+module\s+named\s+['"]?djlint['"]?(?![\w.])/u;

const CANNOT_START: ReadonlySet<string | undefined> = new Set([
  "EACCES",
  "ENOENT",
  "ENOEXEC",
  "UNKNOWN",
]);

// How a shell, a version manager's shim, or on Windows a venv whose base Python is gone says that a command is not there.
const COMMAND_NOT_FOUND: ReadonlySet<number | undefined> = new Set([
  103, 127, 9009,
]);

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

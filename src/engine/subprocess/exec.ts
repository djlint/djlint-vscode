import { ExecaError } from "execa";

export interface ChildOptions {
  input: string;
  stripFinalNewline: boolean;
  cwd?: string;
  cancelSignal: AbortSignal;
  env: NodeJS.ProcessEnv;
  timeout: number;
}

export type CustomExecaError = ExecaError<ChildOptions>;

export function isCustomExecaError(e: unknown): e is CustomExecaError {
  return e instanceof ExecaError;
}

const NO_DJLINT_MODULE_REGEX =
  /No\s+module\s+named\s+['"]?djlint['"]?(?![\w.])/u;

export function isDjlintUnavailable(e: CustomExecaError): boolean {
  return e.code === "ENOENT" || NO_DJLINT_MODULE_REGEX.test(e.stderr);
}

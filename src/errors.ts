import type { ExecaError } from "execa";
import { formattingArgs, lintingArgs } from "./args";

const goodStderrRegex = /(?:^$|Linting\s+\d+\/\d+\s+files)/u;
const noModuleNamedDjlintRegex = /No\s+module\s+named\s+djlint/u;
const noSuchOptionRegex = /No\s+such\s+option:\s*(?<option>\S+)/u;
const argsMap = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg]),
);

export class ErrorMessageWrapper extends Error {
  constructor(
    readonly originalError: Error,
    message: string,
  ) {
    super(message);
  }
}

export function checkErrors(error: ExecaError, pythonExec: string): void {
  if ((error.exitCode as number | null | undefined) != null) {
    const stderr = error.stderr;

    if (goodStderrRegex.test(stderr)) {
      return;
    }

    if (noModuleNamedDjlintRegex.test(stderr)) {
      const errMsg = `djLint is not installed for the current active Python interpreter. Install it with the \`${pythonExec} -m pip install -U djlint\` command.`;
      throw new ErrorMessageWrapper(error, errMsg);
    }

    const noSuchOption = noSuchOptionRegex.exec(stderr)?.groups?.["option"];
    if (noSuchOption) {
      const arg = argsMap.get(noSuchOption);
      if (arg) {
        const option = arg.vscodeName
          ? `djlint.${arg.vscodeName}`
          : arg.cliName;
        const errMsg = `Your version of djLint does not support the \`${option}\` option. Disable it in the settings or update djLint with the \`${pythonExec} -m pip install -U djlint>=${arg.minVersion}\` command.`;
        throw new ErrorMessageWrapper(error, errMsg);
      }
    }
  }

  throw error;
}

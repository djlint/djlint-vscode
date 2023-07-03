import { formattingArgs, lintingArgs } from "./args";

const noModuleNamedDjlintRegex = /No\s+module\s+named\s+djlint/;
const goodStderrRegex = /Linting\s+\d+\/\d+\s+files/;
const noSuchOptionRegex = /No\s+such\s+option:\s*(\S+)/;
const argsMap = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg])
);

export class ErrorWithUserMessage extends Error {
  constructor(message: string, readonly userMessage: string) {
    super(message);
  }
}

export function checkErrors(stderr: string, pythonExec: string): void {
  if (!stderr) {
    return;
  }

  if (noModuleNamedDjlintRegex.test(stderr)) {
    throw new ErrorWithUserMessage(
      stderr,
      `djLint is not installed for the current active Python interpreter. Install it with the \`${pythonExec} -m pip install -U djlint\` command.`
    );
  }

  // Workaround for djLint < 1.18
  if (goodStderrRegex.test(stderr)) {
    return;
  }

  const noSuchOption = noSuchOptionRegex.exec(stderr);
  if (noSuchOption) {
    const arg = argsMap.get(noSuchOption[1]);
    if (arg) {
      const option = arg.vscodeName ? `djlint.${arg.vscodeName}` : arg.cliName;
      throw new ErrorWithUserMessage(
        stderr,
        `Your version of djLint does not support the \`${option}\` option. Disable it in the settings or update djLint with the \`${pythonExec} -m pip install -U djlint>=${arg.minVersion}\` command.`
      );
    }
  }

  throw new Error(stderr);
}

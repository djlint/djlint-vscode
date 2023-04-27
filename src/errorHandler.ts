import { formattingArgs, lintingArgs } from "./args";

const goodStderrRegex = /Linting\s+\d+\/\d+\s+files/;
const noSuchOptionRegex = /No\s+such\s+option:\s+(\S+)/;
const argsMap = new Map(
  [...formattingArgs, ...lintingArgs].map((arg) => [arg.cliName, arg])
);

export function getErrorMsg(stderr: string): string | null {
  if (stderr.endsWith("No module named djlint")) {
    return "djLint is not installed for the current active Python interpreter.";
  }

  // Workaround for djLint < 1.18
  if (goodStderrRegex.test(stderr)) {
    return null;
  }

  const noSuchOption = stderr.match(noSuchOptionRegex);
  if (noSuchOption) {
    const arg = argsMap.get(noSuchOption[1]);
    if (arg) {
      return `Your version of djLint does not support the ${
        arg.vscodeName
      } option. Disable it in the settings or update djLint ≥ ${
        arg.minVersion ?? "undefined"
      }.`;
    }
  }

  return stderr;
}
